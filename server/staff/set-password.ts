import { randomUUID } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import { and, eq, gt, isNull, like, sql } from 'drizzle-orm'
import { isGuestUserId } from '../../shared/access.js'
import { recordAudit } from '../audit.js'
import type { Db } from '../db/client.js'
import {
  account,
  oauthAccessToken,
  oauthConsent,
  oauthRefreshToken,
  session,
  user,
  userRole,
  verification,
} from '../db/schema.js'
import { hashLinkToken, newLinkToken } from '../documents/service.js'
import { sendEmail, type Delivery } from '../email/send.js'
import { appOrigin } from '../env.js'

/**
 * "Set your password" links, for a staff login that has no password yet or
 * forgot it. The link only ever goes to the login's own address, works once,
 * for an hour, and only a hash of it is stored (in Better Auth's verification
 * table, so no new table). Setting a password doesn't touch two-factor: an
 * account that has it still needs its code, and one that doesn't is sent to
 * set it up before it sees anything.
 */
export const SET_PASSWORD_PREFIX = 'set-password:'
export const SET_PASSWORD_TTL_MS = 60 * 60 * 1000
/** One email per login this often, so the form can't be used to flood an inbox. */
export const SET_PASSWORD_GAP_MS = 10 * 60 * 1000
export const PASSWORD_MIN = 12
export const PASSWORD_MAX = 128

export function setPasswordEmail(input: { name: string; url: string }): { subject: string; text: string } {
  const greeting = input.name.trim() ? `Hi ${input.name.trim()},` : 'Hi,'
  const text = [
    greeting,
    '',
    'Use this link to set your password for the Theatre Raleigh company app:',
    input.url,
    '',
    'It works once, for the next hour. After that you sign in as usual, and set up two-factor sign-in if you haven’t yet.',
    '',
    'If you didn’t ask for this, you can ignore this email. Your password hasn’t changed.',
  ].join('\n')
  return { subject: 'Set your Theatre Raleigh password', text }
}

type Send = typeof sendEmail

/**
 * Emails a set-password link to a staff login, if there is one at this
 * address. Says nothing either way, so the form can't be used to find out who
 * has a login.
 */
export async function requestSetPassword(db: Db, email: string, deps: { send?: Send } = {}): Promise<void> {
  const address = email.trim().toLowerCase()
  const [staff] = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .innerJoin(userRole, eq(userRole.userId, user.id))
    .where(eq(sql`lower(${user.email})`, address))
    .limit(1)
  if (!staff || isGuestUserId(staff.id)) return

  // Check and claim the ten-minute slot under a lock on the login, so a burst
  // of requests can't all pass the check before one of them saves a link.
  const token = newLinkToken()
  const id = randomUUID()
  const claimed = await db.transaction(async (tx) => {
    await tx.select({ id: user.id }).from(user).where(eq(user.id, staff.id)).for('update')
    const [recent] = await tx
      .select({ id: verification.id })
      .from(verification)
      .where(
        and(
          eq(verification.value, staff.id),
          like(verification.identifier, `${SET_PASSWORD_PREFIX}%`),
          gt(verification.createdAt, new Date(Date.now() - SET_PASSWORD_GAP_MS)),
        ),
      )
      .limit(1)
    if (recent) return false
    await tx.insert(verification).values({
      id,
      identifier: SET_PASSWORD_PREFIX + hashLinkToken(token),
      value: staff.id,
      expiresAt: new Date(Date.now() + SET_PASSWORD_TTL_MS),
    })
    return true
  })
  if (!claimed) return

  const { subject, text } = setPasswordEmail({ name: staff.name, url: `${appOrigin()}/set-password/${token}` })
  let delivery: Delivery | 'failed'
  try {
    delivery = (await (deps.send ?? sendEmail)({ to: staff.email, subject, text }, { isDemo: false })).delivery
  } catch {
    delivery = 'failed'
  }
  // A link that didn't go out is no use to anyone, so it doesn't stay behind.
  if (delivery !== 'sent') await db.delete(verification).where(eq(verification.id, id))
  await recordAudit(db, {
    actorId: null,
    action: 'send',
    recordType: 'set_password_link',
    recordId: staff.id,
    via: 'system',
    detail: { delivery },
  })
}

/**
 * Sets the password behind a link and uses the link up. Signs the login out
 * everywhere and disconnects its apps, so nothing outlives a password change.
 */
export async function setPasswordWithToken(db: Db, token: string, password: string): Promise<'ok' | 'invalid'> {
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) return 'invalid'
  const live = and(
    eq(verification.identifier, SET_PASSWORD_PREFIX + hashLinkToken(token)),
    gt(verification.expiresAt, new Date()),
  )
  // A bad link is turned away before the (deliberately slow) password hash runs.
  const [found] = await db.select({ id: verification.id }).from(verification).where(live).limit(1)
  if (!found) return 'invalid'
  const hash = await hashPassword(password)
  return db.transaction(async (tx) => {
    // Deleting is what uses the link up, so two tabs can't both use it.
    const [link] = await tx.delete(verification).where(live).returning({ userId: verification.value })
    if (!link || isGuestUserId(link.userId)) return 'invalid'
    const [existing] = await tx
      .select({ id: account.id })
      .from(account)
      .where(and(eq(account.userId, link.userId), eq(account.providerId, 'credential')))
      .limit(1)
    if (existing) {
      await tx.update(account).set({ password: hash }).where(eq(account.id, existing.id))
    } else {
      await tx.insert(account).values({
        id: randomUUID(),
        userId: link.userId,
        accountId: link.userId,
        providerId: 'credential',
        password: hash,
      })
    }
    // Any other link for this login is now stale.
    await tx
      .delete(verification)
      .where(and(eq(verification.value, link.userId), like(verification.identifier, `${SET_PASSWORD_PREFIX}%`)))
    // Sign out everywhere, Claude's connector included: a connection made
    // before the change mustn't outlive it.
    await tx.delete(session).where(eq(session.userId, link.userId))
    const now = new Date()
    await tx.delete(oauthConsent).where(eq(oauthConsent.userId, link.userId))
    await tx
      .update(oauthRefreshToken)
      .set({ revoked: now })
      .where(and(eq(oauthRefreshToken.userId, link.userId), isNull(oauthRefreshToken.revoked)))
    await tx
      .update(oauthAccessToken)
      .set({ revoked: now })
      .where(and(eq(oauthAccessToken.userId, link.userId), isNull(oauthAccessToken.revoked)))
    await recordAudit(tx, {
      actorId: link.userId,
      action: 'update',
      recordType: 'password',
      recordId: link.userId,
      via: 'system',
    })
    return 'ok'
  })
}
