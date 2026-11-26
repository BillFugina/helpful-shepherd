import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { base32 } from '@better-auth/utils/base32'
import { createOTP } from '@better-auth/utils/otp'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NEVER_OVER_CONNECTOR, type Role } from '../shared/access.js'
import { isConnected, disconnectApp } from '../server/connector/connections.js'
import { runConnectorTool, type ToolEnv } from '../server/connector/tools.js'
import { createDb, type Db } from '../server/db/client.js'
import {
  auditEvent,
  engagement,
  engagementDraft,
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  person,
  production,
  rateLimit,
  season,
  user,
  userRole,
} from '../server/db/schema.js'
import { handleAuth } from '../server/handlers.js'
import { handleMcp } from '../server/mcp.js'
import { appRouter } from '../server/routers/index.js'
import { ensureDefaultGrants, upsertStaff } from '../server/seed.js'
import { connectorGrants, createCallerFactory, type SessionUser } from '../server/trpc.js'
import { DEFAULT_GRANTS } from '../shared/access.js'

const createCaller = createCallerFactory(appRouter)
const noDb = new Proxy({} as Db, {
  get() {
    throw new Error('this test should not touch the database')
  },
})

function fakeUser(over: Partial<SessionUser> = {}): SessionUser {
  const id = `test-${randomUUID()}`
  return { id, email: `${id}@example.com`, name: 'Tester', twoFactorEnabled: true, ...over }
}

const text = (r: { content: { text: string }[] }) => r.content[0]!.text

describe('connector rules without a database', () => {
  it('never passes DOB, travel IDs, tax and bank, or housing access to the connector', () => {
    const grants = connectorGrants(DEFAULT_GRANTS.company_manager)
    for (const group of NEVER_OVER_CONNECTOR) expect(grants[group]).toBeUndefined()
    expect(grants.general).toBe('edit')
    expect(grants.pay_terms).toBe('edit')
    expect(grants.travel_logistics).toBe('edit')
  })

  it('refuses every write through tRPC before touching data', async () => {
    const caller = createCaller({ db: noDb, user: fakeUser(), via: 'connector' })
    await expect(
      caller.seasons.create({ name: 'X', program: 'main_stage', startsOn: '2031-01-01', endsOn: '2031-02-01' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'CONNECTOR_READ_ONLY' })
  })
})

const url = process.env.DATABASE_URL
describe.skipIf(!url)('connector against Postgres', () => {
  const db = (url ? createDb(url) : null) as Db
  const cm = fakeUser()
  const finance = fakeUser()
  const tag = randomUUID().slice(0, 8)
  const clientId = `test-client-${tag}`
  let seasonId = ''
  let productionId = ''
  let personId = ''
  let engagementId = ''
  const people: string[] = []

  const asCm = () => createCaller({ db, user: cm })
  const env = (u: SessionUser): ToolEnv => ({ db, user: u, clientId })

  async function addUser(u: SessionUser, role: Role) {
    await db.insert(user).values({ id: u.id, email: u.email, name: u.name, twoFactorEnabled: true })
    await db.insert(userRole).values({ userId: u.id, role })
  }

  beforeAll(async () => {
    await ensureDefaultGrants(db)
    await addUser(cm, 'company_manager')
    await addUser(finance, 'finance_manager')
    const s = await asCm().seasons.create({
      name: `Connector season ${tag}`,
      program: 'main_stage',
      startsOn: '2032-01-01',
      endsOn: '2032-12-31',
    })
    seasonId = s.id
    const p = await asCm().productions.create({
      seasonId,
      title: `Connector show ${tag}`,
      rehearsalStart: '2032-02-01',
      opening: '2032-03-01',
      closing: '2032-03-20',
    })
    productionId = p.id
    const pr = await asCm().people.create({
      legalName: `Rowan Vale ${tag}`,
      email: `rowan.${tag}@example.com`,
      dob: '1990-04-05',
      tsaKtn: 'KTN12345',
    })
    personId = pr.id
    people.push(pr.id)
    const e = await asCm().engagements.quickCreate({
      productionId,
      person: { kind: 'existing', personId },
      agent: { kind: 'none' },
      terms: { role: 'Ensemble', contractType: 'equity_itc', weeklyPayCents: 95000, housingProvided: true },
      conflicts: [{ startsOn: '2032-02-10', endsOn: '2032-02-11', description: 'Wedding' }],
    })
    engagementId = e.id
    await db.insert(oauthClient).values({
      id: randomUUID(),
      clientId,
      name: 'Claude (test)',
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
    })
  })

  afterAll(async () => {
    await db.delete(engagementDraft).where(eq(engagementDraft.productionId, productionId))
    await db.delete(engagement).where(eq(engagement.productionId, productionId))
    await db.delete(production).where(eq(production.seasonId, seasonId))
    await db.delete(season).where(eq(season.id, seasonId))
    if (people.length) await db.delete(person).where(inArray(person.id, people))
    await db.delete(oauthClient).where(eq(oauthClient.clientId, clientId))
    await db.delete(user).where(inArray(user.id, [cm.id, finance.id]))
  })

  it('reads through the role filter, without DOB, travel IDs or housing', async () => {
    const card = await runConnectorTool(env(cm), 'person_card', { engagementId })
    expect(card.isError).toBeUndefined()
    const body = text(card)
    expect(body).toContain(`Rowan Vale ${tag}`)
    expect(body).toContain('Wedding')
    expect(body).toContain('95000')
    expect(body).not.toContain('1990-04-05')
    expect(body).not.toContain('KTN12345')
    expect(body).not.toMatch(/"dob"|"tsaKtn"|"frequentFlyer"|doorCode|housingAddress/)

    const profile = text(await runConnectorTool(env(cm), 'get_person', { personId }))
    expect(profile).not.toContain('1990-04-05')
    expect(profile).not.toContain('KTN12345')
  })

  it("keeps Finance's pay view but not more", async () => {
    const roster = await runConnectorTool(env(finance), 'production_roster', { productionId })
    expect(roster.isError).toBeUndefined()
    expect(text(roster)).toContain(`Rowan Vale ${tag}`)
    const arrivals = await runConnectorTool(env(finance), 'arrivals_board', {})
    expect(arrivals.isError).toBe(true)
  })

  it('lists productions and upcoming conflicts', async () => {
    const list = JSON.parse(text(await runConnectorTool(env(cm), 'list_productions', {}))) as { id: string }[]
    expect(list.some((p) => p.id === productionId)).toBe(true)
    const conflicts = JSON.parse(
      text(await runConnectorTool(env(cm), 'production_conflicts', { productionId, includePast: true })),
    ) as { description: string }[]
    expect(conflicts.map((c) => c.description)).toContain('Wedding')
  })

  it('writes an audit event for every call, marked as the connector, without the search text', async () => {
    const connectorEvents = () =>
      db
        .select()
        .from(auditEvent)
        .where(and(eq(auditEvent.actorId, cm.id), eq(auditEvent.recordType, 'connector_tool')))
    // Compare by row, not by time: the database's clock has microseconds and
    // Node's doesn't, so an earlier test's call can land in the same millisecond.
    const seen = new Set((await connectorEvents()).map((r) => r.id))
    await runConnectorTool(env(cm), 'find_people', { name: `Vale ${tag}` })
    const latest = (await connectorEvents()).filter((r) => !seen.has(r.id))
    expect(latest).toHaveLength(1)
    expect(latest[0]).toMatchObject({ action: 'read', via: 'connector' })
    expect(latest[0]!.detail).toMatchObject({ tool: 'find_people', client: clientId, count: 1 })
    expect(JSON.stringify(latest[0]!.detail)).not.toContain(`Vale ${tag}`)
  })

  it('audits refused calls too', async () => {
    const res = await runConnectorTool(env(finance), 'draft_engagement_from_email', {
      productionId,
      emailText: 'Hi, accepting!',
      person: { legalName: 'Nope' },
      terms: { role: 'Ensemble' },
    })
    expect(res.isError).toBe(true)
    const rows = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.actorId, finance.id), eq(auditEvent.recordType, 'connector_tool')))
    expect(rows.some((r) => (r.detail as { outcome?: string }).outcome === 'denied')).toBe(true)
    const drafts = await db.select().from(engagementDraft).where(eq(engagementDraft.productionId, productionId))
    expect(drafts).toHaveLength(0)
  })

  describe('drafts from acceptance emails', () => {
    const emailText = `Dear Company Manager, I'm delighted to accept the role of Swing in Connector show ${tag}. $1,100 a week works. My agent is Pat Lee at Lee Talent.`
    let draftId = ''

    it('saves a pending draft and nothing else', async () => {
      const peopleBefore = await db.select({ id: person.id }).from(person)
      const res = await runConnectorTool(env(cm), 'draft_engagement_from_email', {
        productionId,
        emailText,
        person: { legalName: `Sky Marsh ${tag}`, email: `sky.${tag}@example.com` },
        agent: { name: `Pat Lee ${tag}`, agency: 'Lee Talent' },
        terms: { role: 'Swing', contractType: 'equity_itc', weeklyPayDollars: 1100, housingProvided: true },
        conflicts: [{ startsOn: '2032-02-14', endsOn: '2032-02-14', description: 'Audition' }],
      })
      expect(res.isError).toBeUndefined()
      const out = JSON.parse(text(res)) as { draftId: string; status: string; returningPerson: boolean }
      expect(out).toMatchObject({ status: 'pending', returningPerson: false })
      draftId = out.draftId
      const peopleAfter = await db.select({ id: person.id }).from(person)
      expect(peopleAfter.length).toBe(peopleBefore.length)

      const draft = await asCm().drafts.get({ id: draftId })
      expect('weeklyPayCents' in draft.terms && draft.terms.weeklyPayCents).toBe(110000)
      expect(draft.sourceText).toBe(emailText)
      expect(draft.person.email).toBe(`sky.${tag}@example.com`)
      const queue = await asCm().drafts.list()
      expect(queue.some((d) => d.id === draftId)).toBe(true)
      const fromTool = JSON.parse(text(await runConnectorTool(env(cm), 'list_drafts', {}))) as { draftId: string }[]
      expect(fromTool.some((d) => d.draftId === draftId)).toBe(true)
    })

    it('spots a returning person by email', async () => {
      const res = await runConnectorTool(env(cm), 'draft_engagement_from_email', {
        productionId,
        emailText: 'Back again!',
        person: { legalName: 'R. Vale', email: `ROWAN.${tag}@example.com` },
        terms: { role: 'Dance captain' },
      })
      const out = JSON.parse(text(res)) as { draftId: string; returningPerson: boolean }
      expect(out.returningPerson).toBe(true)
      const draft = await asCm().drafts.get({ id: out.draftId })
      expect(draft.matchedPerson?.id).toBe(personId)
      await asCm().drafts.dismiss({ id: out.draftId })
      await expect(asCm().drafts.dismiss({ id: out.draftId })).rejects.toMatchObject({ code: 'CONFLICT' })
    })

    it("hides the draft's pay and the email from roles that can't see them, and keeps Finance out of the queue", async () => {
      await expect(createCaller({ db, user: finance }).drafts.list()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    })

    it('becomes real only when saved in the app, once', async () => {
      const input = {
        productionId,
        draftId,
        person: { kind: 'new' as const, person: { legalName: `Sky Marsh ${tag}`, email: `sky.${tag}@example.com` } },
        agent: { kind: 'none' as const },
        terms: { role: 'Swing', contractType: 'equity_itc' as const },
      }
      const saved = await asCm().engagements.quickCreate(input)
      const [row] = await db.select().from(engagementDraft).where(eq(engagementDraft.id, draftId))
      expect(row).toMatchObject({ status: 'accepted', engagementId: saved.id, decidedBy: cm.id, sourceText: null })
      const [created] = await db
        .select({ personId: engagement.personId })
        .from(engagement)
        .where(eq(engagement.id, saved.id))
      people.push(created!.personId)

      await expect(asCm().engagements.quickCreate(input)).rejects.toMatchObject({ code: 'CONFLICT' })
    })
  })

  it('disconnecting removes the approval, revokes tokens and is audited', async () => {
    await db.insert(oauthConsent).values({
      id: randomUUID(),
      clientId,
      userId: cm.id,
      scopes: ['openid', 'offline_access'],
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    expect(await isConnected(db, cm.id, clientId)).toBe(true)
    const listed = await asCm().connections.list()
    expect(listed.map((c) => c.clientId)).toContain(clientId)

    const result = await asCm().connections.disconnect({ clientId })
    expect(result.disconnected).toBe(true)
    expect(await isConnected(db, cm.id, clientId)).toBe(false)
    const events = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.actorId, cm.id), eq(auditEvent.action, 'disconnect')))
    expect(events).toHaveLength(1)
    expect((await disconnectApp(db, cm, clientId)).disconnected).toBe(false)
  })
})

/**
 * The whole connection the way Claude makes it: register, send the person
 * through sign-in (with 2FA) and the Connect page, trade the code for a
 * token, call tools, then lose access the moment the person disconnects.
 */
describe.skipIf(!url)('connecting Claude over OAuth', () => {
  const db = (url ? createDb(url) : null) as Db
  const origin = 'http://localhost:5173'
  const email = `connector-${randomUUID()}@example.com`
  const password = 'correct horse battery staple'
  const redirectUri = 'https://claude.ai/api/mcp/auth_callback'
  const resource = `${origin}/api/mcp`
  const jar = new Map<string, string>()
  let userId = ''
  let clientId = ''
  let accessToken = ''
  let refreshToken = ''

  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
  function keep(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const [name, ...value] = pair!.split('=')
      jar.set(name!, value.join('='))
    }
    return res
  }
  const post = async (path: string, body: unknown, withCookie = true) =>
    keep(
      await handleAuth(
        new Request(`${origin}/api/auth${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin, ...(withCookie ? { cookie: cookie() } : {}) },
          body: JSON.stringify(body),
        }),
      ),
    )
  const mcp = (body: unknown, token = accessToken) =>
    handleMcp(
      new Request(resource, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-06-18',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    )

  /** The 2025-era stateless transport answers over SSE; pull out the JSON-RPC message. */
  async function rpc<T>(res: Response): Promise<T> {
    const body = await res.text()
    const data = body.startsWith('{')
      ? body
      : body
          .split('\n')
          .find((l) => l.startsWith('data: '))
          ?.slice(6)
    return JSON.parse(data ?? 'null') as T
  }

  beforeAll(async () => {
    process.env.BETTER_AUTH_URL = origin
    await db.delete(rateLimit)
    await ensureDefaultGrants(db)
    await upsertStaff(db, { email, name: 'Connector Tester', role: 'company_manager' }, password)
    const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, email))
    userId = row!.id
    // Sign in and turn on two-factor, as the app requires.
    await post('/sign-in/email', { email, password })
    const enable = await post('/two-factor/enable', { password })
    const { totpURI } = (await enable.json()) as { totpURI: string }
    const secret = new TextDecoder().decode(base32.decode(new URL(totpURI).searchParams.get('secret')!))
    const verify = await post('/two-factor/verify-totp', { code: await createOTP(secret).totp() })
    expect(verify.ok).toBe(true)
  })

  afterAll(async () => {
    if (clientId) {
      await db.delete(oauthAccessToken).where(eq(oauthAccessToken.clientId, clientId))
      await db.delete(oauthRefreshToken).where(eq(oauthRefreshToken.clientId, clientId))
      await db.delete(oauthClient).where(eq(oauthClient.clientId, clientId))
    }
    if (userId) await db.delete(user).where(eq(user.id, userId))
    await db.delete(rateLimit)
  })

  it('answers an unsigned request with where to sign in', async () => {
    const res = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, '')
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain(
      `resource_metadata="${origin}/.well-known/oauth-protected-resource/api/mcp"`,
    )
  })

  it('publishes discovery documents', async () => {
    const prm = await handleAuth(new Request(`${origin}/.well-known/oauth-protected-resource/api/mcp`))
    expect(await prm.json()).toMatchObject({ resource, authorization_servers: [`${origin}/api/auth`] })
    const as = await handleAuth(new Request(`${origin}/.well-known/oauth-authorization-server/api/auth`))
    const meta = (await as.json()) as Record<string, unknown>
    expect(meta).toMatchObject({
      issuer: `${origin}/api/auth`,
      registration_endpoint: `${origin}/api/auth/oauth2/register`,
    })
    expect(meta.code_challenge_methods_supported).toContain('S256')
  })

  it('registers, signs in, approves, and calls tools', async () => {
    const reg = await post(
      '/oauth2/register',
      {
        client_name: 'Claude',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      false,
    )
    expect(reg.status).toBeLessThan(300)
    clientId = ((await reg.json()) as { client_id: string }).client_id

    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const authorize = new URL(`${origin}/api/auth/oauth2/authorize`)
    for (const [k, v] of Object.entries({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'openid profile email offline_access',
      state: 'xyz',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource,
    }))
      authorize.searchParams.set(k, v)
    const auth = await handleAuth(new Request(authorize, { headers: { cookie: cookie() } }))
    const toConsent = new URL(auth.headers.get('location') ?? '', origin)
    expect(toConsent.pathname).toBe('/connect')

    const consent = await post('/oauth2/consent', { accept: true, oauth_query: toConsent.search.slice(1) })
    expect(consent.ok).toBe(true)
    const back = new URL(((await consent.json()) as { url: string }).url)
    expect(`${back.origin}${back.pathname}`).toBe(redirectUri)
    expect(back.searchParams.get('state')).toBe('xyz')
    const code = back.searchParams.get('code')!

    const token = await handleAuth(
      new Request(`${origin}/api/auth/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: verifier,
          resource,
        }),
      }),
    )
    expect(token.status).toBe(200)
    const tokens = (await token.json()) as { access_token: string; refresh_token?: string }
    accessToken = tokens.access_token
    refreshToken = tokens.refresh_token ?? ''
    expect(accessToken.split('.')).toHaveLength(3)
    expect(refreshToken).not.toBe('')

    const init = await mcp({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    })
    expect(init.status).toBe(200)

    const list = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const tools = (await rpc<{ result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] } }>(list))
      .result.tools
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['list_productions', 'person_card', 'arrivals_board', 'draft_engagement_from_email']),
    )
    expect(tools.find((t) => t.name === 'person_card')?.annotations?.readOnlyHint).toBe(true)

    const call = await mcp({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_productions', arguments: {} },
    })
    const result = (await rpc<{ result: { isError?: boolean; content: { text: string }[] } }>(call)).result
    expect(result.isError).toBeFalsy()
    expect(Array.isArray(JSON.parse(result.content[0]!.text))).toBe(true)

    const connected = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.actorId, userId), eq(auditEvent.action, 'connect')))
    expect(connected).toHaveLength(1)
  })

  it('stops working the moment the person disconnects', async () => {
    const owner: SessionUser = { id: userId, email, name: 'Connector Tester', twoFactorEnabled: true }
    expect((await disconnectApp(db, owner, clientId)).disconnected).toBe(true)
    const res = await mcp({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'list_productions', arguments: {} },
    })
    expect(res.status).toBe(401)

    const refresh = await handleAuth(
      new Request(`${origin}/api/auth/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }),
      }),
    )
    expect(refresh.ok).toBe(false)
  })
})
