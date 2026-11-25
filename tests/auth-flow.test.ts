import { randomUUID } from 'node:crypto'
import { base32 } from '@better-auth/utils/base32'
import { createOTP } from '@better-auth/utils/otp'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '../server/db/client.js'
import { auditEvent, rateLimit, user } from '../server/db/schema.js'
import { createContext, handleAuth } from '../server/handlers.js'
import { upsertStaff } from '../server/seed.js'

/**
 * Drives Better Auth over HTTP the way the browser does: sign in, turn on
 * two-factor, then sign in again and pass the second factor.
 */
const url = process.env.DATABASE_URL
describe.skipIf(!url)('sign-in with two-factor', () => {
  const db = createDb(url ?? '')
  const origin = 'http://localhost:5173'
  const email = `staff-${randomUUID()}@example.com`
  const password = 'correct horse battery staple'
  let userId = ''
  let totpSecret = ''

  function post(path: string, body: unknown, cookie = '') {
    return handleAuth(
      new Request(`${origin}/api/auth${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, cookie },
        body: JSON.stringify(body),
      }),
    )
  }

  /** Folds Set-Cookie headers into a Cookie header value. */
  function cookiesFrom(res: Response, jar = new Map<string, string>()) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const [name, ...value] = pair!.split('=')
      jar.set(name!, value.join('='))
    }
    return jar
  }
  const header = (jar: Map<string, string>) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')

  beforeAll(async () => {
    process.env.BETTER_AUTH_URL = origin
    // Earlier runs share the rate-limit counters; start clean.
    await db.delete(rateLimit)
    await upsertStaff(db, { email, name: 'Staff Tester', role: 'finance_manager' }, password)
    const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, email))
    userId = row!.id
  })

  afterAll(async () => {
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(rateLimit)
  })

  it('refuses self sign-up', async () => {
    const res = await post('/sign-up/email', { email: `x-${randomUUID()}@example.com`, password, name: 'X' })
    expect(res.ok).toBe(false)
  })

  it('refuses a wrong password', async () => {
    const res = await post('/sign-in/email', { email, password: 'wrong password here' })
    expect(res.status).toBe(401)
  })

  it('signs in, but the API holds back data until two-factor is on', async () => {
    const res = await post('/sign-in/email', { email, password })
    expect(res.ok).toBe(true)
    const jar = cookiesFrom(res)
    const ctx = await createContext(new Request(`${origin}/api/trpc/me`, { headers: { cookie: header(jar) } }))
    expect(ctx.user).toMatchObject({ email, twoFactorEnabled: false })

    const enable = await post('/two-factor/enable', { password }, header(jar))
    expect(enable.ok).toBe(true)
    const { totpURI, backupCodes } = (await enable.json()) as { totpURI: string; backupCodes: string[] }
    expect(backupCodes.length).toBeGreaterThan(0)
    totpSecret = new TextDecoder().decode(base32.decode(new URL(totpURI).searchParams.get('secret')!))

    cookiesFrom(enable, jar)
    const verify = await post('/two-factor/verify-totp', { code: await createOTP(totpSecret).totp() }, header(jar))
    expect(verify.ok).toBe(true)
    const [row] = await db.select({ on: user.twoFactorEnabled }).from(user).where(eq(user.id, userId))
    expect(row?.on).toBe(true)
  })

  it('next sign-in asks for the second factor before creating a session', async () => {
    const res = await post('/sign-in/email', { email, password })
    expect(await res.clone().json()).toMatchObject({ twoFactorRedirect: true })
    const jar = cookiesFrom(res)
    const before = await createContext(new Request(`${origin}/api/trpc/me`, { headers: { cookie: header(jar) } }))
    expect(before.user).toBeNull()

    const bad = await post('/two-factor/verify-totp', { code: '000000' }, header(jar))
    expect(bad.ok).toBe(false)

    const good = await post('/two-factor/verify-totp', { code: await createOTP(totpSecret).totp() }, header(jar))
    expect(good.ok).toBe(true)
    cookiesFrom(good, jar)
    const after = await createContext(new Request(`${origin}/api/trpc/me`, { headers: { cookie: header(jar) } }))
    expect(after.user).toMatchObject({ email, twoFactorEnabled: true })

    const signIns = await db.select().from(auditEvent).where(eq(auditEvent.actorId, userId))
    expect(signIns.filter((e) => e.action === 'sign_in').length).toBeGreaterThanOrEqual(2)
  })

  it('rate-limits repeated sign-in attempts', async () => {
    await db.delete(rateLimit)
    const statuses: number[] = []
    for (let i = 0; i < 7; i++) {
      statuses.push((await post('/sign-in/email', { email, password: 'wrong password here' })).status)
    }
    expect(statuses).toContain(429)
  })
})
