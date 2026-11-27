import { and, eq, gte, sql } from 'drizzle-orm'
import { sendNotification, type PushSubscriptionTarget, type RequestOptions, type SendResult } from 'web-push'
import { isGuestUserId } from '../../shared/access.js'
import { companyManagers } from '../alerts/recipients.js'
import { recordAudit } from '../audit.js'
import type { Db } from '../db/client.js'
import { pushSubscription, user } from '../db/schema.js'
import { isReservedAddress } from '../email/send.js'
import { appOrigin, env, type Env } from '../env.js'

export type PushMode = 'off' | 'allowlist' | 'live'

/** The VAPID keys and subject, or null when phone alerts aren't set up here. */
export function vapidDetails(e: Env = env()): { subject: string; publicKey: string; privateKey: string } | null {
  if (!e.VAPID_PUBLIC_KEY || !e.VAPID_PRIVATE_KEY) return null
  return { subject: e.VAPID_SUBJECT || appOrigin(e), publicKey: e.VAPID_PUBLIC_KEY, privateKey: e.VAPID_PRIVATE_KEY }
}

/** The mode in effect. Without both keys it's always off. */
export function pushMode(e: Env = env()): PushMode {
  if (!vapidDetails(e)) return 'off'
  return e.PUSH_DELIVERY ?? 'off'
}

function allowlist(e: Env): Set<string> {
  return new Set(
    (e.PUSH_ALLOWLIST ?? '')
      .split(',')
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean),
  )
}

/**
 * Whether this login may get phone alerts right now. Null means yes; otherwise
 * the reason, in words for the settings page. Demo logins (reserved domains)
 * never do, even when listed.
 */
export function pushDecision(email: string, e: Env = env()): string | null {
  const mode = pushMode(e)
  if (mode === 'off') return 'Phone alerts are turned off on this server, so nothing is sent.'
  if (isReservedAddress(email)) return 'Demo logins never get phone alerts.'
  if (mode === 'allowlist' && !allowlist(e).has(email.trim().toLowerCase())) {
    return 'This login isn’t on the phone alert test list, so alerts are held.'
  }
  return null
}

// The push services browsers use. A subscription naming any other host is
// refused, so a made-up endpoint can't turn the server into a request relay.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/, // Chrome, Edge on Android, Samsung Internet, Opera
  /^updates\.push\.services\.mozilla\.com$/, // Firefox
  /^([a-z0-9-]+\.)*push\.apple\.com$/, // Safari, iPhone and iPad Home Screen apps
  /^([a-z0-9-]+\.)*notify\.windows\.com$/, // Edge on Windows
]

export function isPushEndpoint(endpoint: string): boolean {
  let u: URL
  try {
    u = new URL(endpoint)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false
  return PUSH_HOSTS.some((h) => h.test(u.hostname.toLowerCase()))
}

/** What a phone alert says, and the page it opens. */
export interface PushNotice {
  title: string
  body: string
  /** A path in this app, like /arrivals. */
  path: string
}

const BODY_MAX = 600

/**
 * The message, in the Declarative Web Push shape (RFC 8030 homage, Safari
 * 18.4+). Newer Safari shows it without running our script; everywhere else
 * public/sw.js reads the same JSON and shows it.
 */
export function pushPayload(notice: PushNotice, origin: string): string {
  const body = notice.body.length > BODY_MAX ? `${notice.body.slice(0, BODY_MAX - 1)}…` : notice.body
  const path = notice.path.startsWith('/') && !notice.path.startsWith('//') ? notice.path : '/'
  return JSON.stringify({
    web_push: 8030,
    notification: {
      title: notice.title.slice(0, 120) || 'Theatre Raleigh',
      body,
      navigate: new URL(path, origin).toString(),
      lang: 'en-US',
      dir: 'ltr',
      silent: false,
    },
  })
}

export type PushSender = (
  subscription: PushSubscriptionTarget,
  payload: string,
  options: RequestOptions,
) => Promise<SendResult>

export interface PushDeps {
  send?: PushSender
  env?: Env
  now?: () => Date
}

export interface PushResult {
  /** Devices the push service accepted the alert for. */
  sent: number
  /** Devices skipped by the rules above (mode, test list, demo login). */
  held: number
  /** Devices removed because the push service says they're gone. */
  removed: number
  /** Devices that failed for another reason this time. */
  failed: number
}

const empty = (): PushResult => ({ sent: 0, held: 0, removed: 0, failed: 0 })

/** Failed sends in a row (not "gone") before a device is dropped. */
export const MAX_FAILURES = 5
/** Flight news is stale after a few hours; the push service drops it then. */
const TTL_SECONDS = 3 * 60 * 60

/**
 * Sends one alert to every device this login turned alerts on for. Never
 * throws for a device: a gone device (404/410) is removed, any other failure
 * is counted, and the rest still go out. So a retry can't repeat alerts.
 */
export async function pushToUser(db: Db, userId: string, notice: PushNotice, deps: PushDeps = {}): Promise<PushResult> {
  const out = empty()
  if (isGuestUserId(userId)) return out
  const e = deps.env ?? env()
  const [u] = await db
    .select({ email: user.email, twoFactorEnabled: user.twoFactorEnabled })
    .from(user)
    .where(eq(user.id, userId))
  if (!u) return out
  const devices = await db.select().from(pushSubscription).where(eq(pushSubscription.userId, userId))
  if (!devices.length) return out
  const vapid = vapidDetails(e)
  if (!u.twoFactorEnabled || pushDecision(u.email, e) || !vapid) {
    out.held = devices.length
    return out
  }
  const payload = pushPayload(notice, appOrigin(e))
  const send = deps.send ?? sendNotification
  const now = deps.now ?? (() => new Date())
  for (const d of devices) {
    let sendError: unknown
    let delivered = false
    try {
      await send({ endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }, payload, {
        vapidDetails: vapid,
        TTL: TTL_SECONDS,
        urgency: 'high',
        timeout: 10_000,
      })
      delivered = true
    } catch (err) {
      sendError = err
    }
    if (delivered) {
      out.sent++
      // Bookkeeping only. A database hiccup here is not a delivery failure,
      // so it never counts toward dropping the device.
      try {
        await db.update(pushSubscription).set({ lastSentAt: now(), failures: 0 }).where(eq(pushSubscription.id, d.id))
      } catch {
        console.error('push: could not record a delivery')
      }
      continue
    }
    const status = (sendError as { statusCode?: unknown }).statusCode
    if (status === 404 || status === 410) {
      await db.delete(pushSubscription).where(eq(pushSubscription.id, d.id))
      out.removed++
      continue
    }
    // The status only: the push service's text can repeat the endpoint.
    console.error('push: send failed', typeof status === 'number' ? status : 'network')
    const [after] = await db
      .update(pushSubscription)
      .set({ failures: sql`${pushSubscription.failures} + 1` })
      .where(eq(pushSubscription.id, d.id))
      .returning({ failures: pushSubscription.failures })
    if (after && after.failures >= MAX_FAILURES) {
      await db
        .delete(pushSubscription)
        .where(and(eq(pushSubscription.id, d.id), gte(pushSubscription.failures, MAX_FAILURES)))
      out.removed++
    } else {
      out.failed++
    }
  }
  return out
}

/**
 * The flight alert push: every Company Manager who sees travel, finished
 * two-factor setup and turned alerts on for a device, under the rules above.
 */
export async function pushToCompanyManagers(db: Db, notice: PushNotice, deps: PushDeps = {}): Promise<PushResult> {
  const total = empty()
  const recipients = await companyManagers(db, 'travel_logistics')
  for (const r of recipients) {
    const one = await pushToUser(db, r.userId, notice, deps)
    total.sent += one.sent
    total.held += one.held
    total.removed += one.removed
    total.failed += one.failed
  }
  if (total.sent + total.held + total.removed + total.failed > 0) {
    await recordAudit(db, {
      actorId: null,
      action: 'send',
      recordType: 'phone_alert',
      via: 'system',
      // Counts only: no names, flights or devices.
      detail: { recipients: recipients.length, ...total },
    })
  }
  return total
}
