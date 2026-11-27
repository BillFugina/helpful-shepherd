import { randomUUID } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import { and, eq, gt, like, sql } from 'drizzle-orm'
import { isGuestUserId } from '../../shared/access.js'
import { recordAudit } from '../audit.js'
import type { Db } from '../db/client.js'
import { account, session, user, userRole, verification } from '../db/schema.js'
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

  const [recent] = await db
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
  if (recent) return

  const token = newLinkToken()
  const id = randomUUID()
  await db.insert(verification).values({
    id,
    identifier: SET_PASSWORD_PREFIX + hashLinkToken(token),
    value: staff.id,
    expiresAt: new Date(Date.now() + SET_PASSWORD_TTL_MS),
  })
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
 * everywhere, so an old session can't outlive a password change.
 */
export async function setPasswordWithToken(db: Db, token: string, password: string): Promise<'ok' | 'invalid'> {
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) return 'invalid'
  const hash = await hashPassword(password)
  return db.transaction(async (tx) => {
    const [link] = await tx
      .delete(verification)
      .where(eq(verification.identifier, SET_PASSWORD_PREFIX + hashLinkToken(token)))
      .returning({ userId: verification.value, expiresAt: verification.expiresAt })
    if (!link || link.expiresAt.getTime() <= Date.now() || isGuestUserId(link.userId)) return 'invalid'
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
    await tx.delete(session).where(eq(session.userId, link.userId))
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
