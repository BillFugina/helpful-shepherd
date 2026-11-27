import { env, type Env } from '../env.js'

export type DeliveryMode = 'log' | 'allowlist' | 'live'

/**
 * What happened to one email.
 * - sent: Resend accepted it.
 * - logged: email is off here (no key, or log mode). Nothing left the app.
 * - held: email is on, but this address isn't allowed to get it.
 */
export type Delivery = 'sent' | 'logged' | 'held'

export interface OutgoingEmail {
  to: string
  subject: string
  text: string
  replyTo?: string | null
}

export interface DeliveryResult {
  delivery: Delivery
  /** Why it wasn't sent, in words the Company Manager can read. */
  reason?: string
}

// Domains that can never receive mail (RFC 2606 / 6761). Demo people use these.
const RESERVED = /(^|\.)(example\.(com|net|org)|example|test|invalid|localhost)$/i

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase()
}

export function isReservedAddress(address: string): boolean {
  return RESERVED.test(domainOf(address))
}

function allowlist(e: Env): Set<string> {
  return new Set(
    (e.EMAIL_ALLOWLIST ?? '')
      .split(',')
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean),
  )
}

/** The mode in effect. Without a key and a sender, it's always log. */
export function deliveryMode(e: Env = env()): DeliveryMode {
  if (!e.RESEND_API_KEY || !e.EMAIL_FROM) return 'log'
  return e.EMAIL_DELIVERY ?? 'log'
}

/**
 * Whether this address may get a real email. Demo people only ever get one
 * when their address is on the allowlist, so seeded data can't reach anyone.
 */
export function deliveryDecision(to: string, opts: { isDemo: boolean }, e: Env = env()): DeliveryResult | null {
  const mode = deliveryMode(e)
  if (mode === 'log') return { delivery: 'logged', reason: 'Email is turned off here, so nothing was sent.' }
  if (isReservedAddress(to)) return { delivery: 'held', reason: 'That address can’t receive email.' }
  const listed = allowlist(e).has(to.trim().toLowerCase())
  if (listed) return null
  if (mode === 'allowlist')
    return { delivery: 'held', reason: 'That address isn’t on the test list, so nothing was sent.' }
  if (opts.isDemo) return { delivery: 'held', reason: 'Demo people never get real email.' }
  return null
}

type Fetch = typeof fetch

/** No line breaks in a header. */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim()

/** Sends one email through Resend, if the rules above allow it. Never throws for a refused address. */
export async function sendEmail(
  msg: OutgoingEmail,
  opts: { isDemo: boolean },
  deps: { fetch?: Fetch; env?: Env } = {},
): Promise<DeliveryResult> {
  const e = deps.env ?? env()
  const decision = deliveryDecision(msg.to, opts, e)
  if (decision) return decision
  const body: Record<string, unknown> = {
    from: e.EMAIL_FROM,
    to: [msg.to.trim()],
    subject: oneLine(msg.subject),
    text: msg.text,
  }
  if (msg.replyTo && !isReservedAddress(msg.replyTo)) body.reply_to = msg.replyTo
  const res = await (deps.fetch ?? fetch)('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${e.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    // The status only: Resend's error text can repeat the address.
    console.error('resend: send failed', res.status)
    throw new Error('The email service didn’t take the email. Try again in a minute.')
  }
  return { delivery: 'sent' }
}
