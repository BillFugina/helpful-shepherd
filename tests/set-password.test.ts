import { randomUUID } from 'node:crypto'
import { verifyPassword } from 'better-auth/crypto'
import { and, eq, inArray, like } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type Db } from '../server/db/client.js'
import { account, auditEvent, session, user, userRole, verification } from '../server/db/schema.js'
import type { sendEmail } from '../server/email/send.js'
import { appRouter } from '../server/routers/index.js'
import {
  requestSetPassword,
  SET_PASSWORD_PREFIX,
  setPasswordEmail,
  setPasswordWithToken,
} from '../server/staff/set-password.js'
import { createCallerFactory } from '../server/trpc.js'
import { GUEST_EMAIL, GUEST_USER_ID } from '../shared/access.js'

const createCaller = createCallerFactory(appRouter)
const url = process.env.DATABASE_URL

describe('set-password email', () => {
  it('carries the link and says two-factor still applies', () => {
    const { subject, text } = setPasswordEmail({ name: 'Bill', url: 'https://app.test/set-password/abc' })
    expect(subject).toBe('Set your Theatre Raleigh password')
    expect(text).toContain('Hi Bill,')
    expect(text).toContain('https://app.test/set-password/abc')
    expect(text).toContain('two-factor')
  })
})

describe.skipIf(!url)('set-password links against Postgres', () => {
  const db = (url ? createDb(url) : null) as Db
  const tag = randomUUID().slice(0, 8)
  const staffId = `test-${randomUUID()}`
  const staffEmail = `staff-${tag}@example.com`
  const noRoleId = `test-${randomUUID()}`
  const noRoleEmail = `norole-${tag}@example.com`
  const sent: { to: string; text: string }[] = []
  const fakeSend = (async (msg: { to: string; text: string }) => {
    sent.push({ to: msg.to, text: msg.text })
    return { delivery: 'sent' as const }
  }) as unknown as typeof sendEmail
  const tokenFrom = (text: string) => text.match(/\/set-password\/([A-Za-z0-9_-]+)/)![1]!
  const links = (userId: string) =>
    db
      .select()
      .from(verification)
      .where(and(eq(verification.value, userId), like(verification.identifier, `${SET_PASSWORD_PREFIX}%`)))

  beforeAll(async () => {
    // A new staff login with a role and no password yet, like one made for someone by hand.
    await db.insert(user).values({ id: staffId, email: staffEmail, name: 'New Staff', emailVerified: true })
    await db.insert(userRole).values({ userId: staffId, role: 'company_manager' })
    await db.insert(user).values({ id: noRoleId, email: noRoleEmail, name: 'No Role', emailVerified: true })
  })

  afterAll(async () => {
    await db.delete(verification).where(inArray(verification.value, [staffId, noRoleId]))
    await db.delete(user).where(inArray(user.id, [staffId, noRoleId]))
  })

  it('emails a staff login a link, storing only its hash, and not again for ten minutes', async () => {
    await requestSetPassword(db, staffEmail.toUpperCase(), { send: fakeSend })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe(staffEmail)
    const token = tokenFrom(sent[0]!.text)
    const rows = await links(staffId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.identifier).not.toContain(token)
    await requestSetPassword(db, staffEmail, { send: fakeSend })
    expect(sent).toHaveLength(1)
  })

  it('sends nothing for an unknown address or a login with no role', async () => {
    await requestSetPassword(db, `nobody-${tag}@example.com`, { send: fakeSend })
    await requestSetPassword(db, noRoleEmail, { send: fakeSend })
    expect(sent).toHaveLength(1)
    expect(await links(noRoleId)).toHaveLength(0)
  })

  it('keeps no link when the email didn’t go out', async () => {
    const held = (async () => ({ delivery: 'held' as const })) as unknown as typeof sendEmail
    await db.delete(verification).where(eq(verification.value, staffId))
    await requestSetPassword(db, staffEmail, { send: held })
    expect(await links(staffId)).toHaveLength(0)
    const audit = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.recordType, 'set_password_link'), eq(auditEvent.recordId, staffId)))
    expect(audit.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(audit.map((a) => a.detail))).not.toContain('/set-password/')
  })

  it('sets the password once, makes the sign-in account, and signs the login out', async () => {
    sent.length = 0
    await requestSetPassword(db, staffEmail, { send: fakeSend })
    const token = tokenFrom(sent[0]!.text)
    await db.insert(session).values({
      id: randomUUID(),
      token: randomUUID(),
      userId: staffId,
      expiresAt: new Date(Date.now() + 60_000),
    })
    expect(await setPasswordWithToken(db, token, 'short')).toBe('invalid')
    expect(await setPasswordWithToken(db, token, 'a long new password 1')).toBe('ok')
    const [acct] = await db
      .select()
      .from(account)
      .where(and(eq(account.userId, staffId), eq(account.providerId, 'credential')))
    expect(await verifyPassword({ hash: acct!.password!, password: 'a long new password 1' })).toBe(true)
    expect(await db.select().from(session).where(eq(session.userId, staffId))).toHaveLength(0)
    expect(await links(staffId)).toHaveLength(0)
    // Single use.
    expect(await setPasswordWithToken(db, token, 'another long password')).toBe('invalid')
    // Two-factor is untouched.
    const [row] = await db.select({ tf: user.twoFactorEnabled }).from(user).where(eq(user.id, staffId))
    expect(row!.tf).toBe(false)
  })

  it('refuses an expired link', async () => {
    const token = 'expired-token-for-a-test-0123456789'
    const { hashLinkToken } = await import('../server/documents/service.js')
    await db.insert(verification).values({
      id: randomUUID(),
      identifier: SET_PASSWORD_PREFIX + hashLinkToken(token),
      value: staffId,
      expiresAt: new Date(Date.now() - 1000),
    })
    expect(await setPasswordWithToken(db, token, 'a long new password 2')).toBe('invalid')
  })

  it('the guest demo and the connector can’t use it, and a bad link gets a plain answer', async () => {
    const guest = { id: GUEST_USER_ID, email: GUEST_EMAIL, name: 'Demo guest', twoFactorEnabled: false }
    await expect(createCaller({ db, user: guest }).password.requestLink({ email: staffEmail })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(
      createCaller({ db, user: null, via: 'connector' }).password.requestLink({ email: staffEmail }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      createCaller({ db, user: null }).password.set({ token: 'x'.repeat(43), password: 'a long new password 3' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
