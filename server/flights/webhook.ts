import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { flightSubscription } from '../db/schema.js'
import { inngest, inngestEnabled } from '../inngest/client.js'
import { hashToken } from './aerodatabox.js'

/** Inngest's event limit is 256 KB; a push for one flight is a few KB. */
export const MAX_PUSH_BYTES = 200_000

const text = (body: string, status: number) => new Response(body, { status, headers: { 'content-type': 'text/plain' } })

/**
 * /api/flight-push/{token}: where AeroDataBox posts flight updates.
 * AeroDataBox doesn't sign its calls, so the random token in the URL is the
 * proof, checked against the hash kept for an active subscription. The work
 * is handed to Inngest so this answers well inside AeroDataBox's 10 seconds.
 */
export async function handleFlightPush(request: Request): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } })
  const token = new URL(request.url).pathname.split('/').filter(Boolean).at(-1) ?? ''
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return text('Not found', 404)
  if (!inngestEnabled()) return text('Not available', 503)
  if (Number(request.headers.get('content-length') ?? '0') > MAX_PUSH_BYTES) return text('Too large', 413)
  const body = await request.text()
  if (body.length > MAX_PUSH_BYTES) return text('Too large', 413)
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return text('Bad request', 400)
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return text('Bad request', 400)

  const [sub] = await db()
    .select({ id: flightSubscription.id })
    .from(flightSubscription)
    .where(and(eq(flightSubscription.tokenHash, hashToken(token)), eq(flightSubscription.active, true)))
    .limit(1)
  if (!sub) return text('Not found', 404)

  await inngest.send({ name: 'aerodatabox/push', data: { subscriptionId: sub.id, payload } })
  return text('ok', 200)
}
