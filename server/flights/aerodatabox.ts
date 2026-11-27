import { createHash, randomBytes } from 'node:crypto'
import { THEATRE_AIRPORT } from '../../shared/time.js'
import type { LiveStatus } from '../../shared/travel.js'
import type { FlightSpec, LiveState } from './provider.js'

// AeroDataBox's Flight Alert Push API, bought directly from AeroDataBox
// (https://doc.aerodatabox.com/direct.html). A subscription is keyed by flight
// number only, so each push has to be matched to the booked flight by its
// date and route. Every flight item in a push costs one credit.

export const ADB_BASE_URL = 'https://api.aerodatabox.com'

export interface AdbTime {
  utc?: string | null
  local?: string | null
}

export interface AdbMovement {
  airport?: { iata?: string | null; icao?: string | null; name?: string | null } | null
  scheduledTime?: AdbTime | null
  revisedTime?: AdbTime | null
  predictedTime?: AdbTime | null
  runwayTime?: AdbTime | null
  terminal?: string | null
  gate?: string | null
  baggageBelt?: string | null
}

/** One flight in a push (FlightNotificationItemContract). Only the fields the app reads. */
export interface AdbFlightItem {
  number?: string | null
  status?: string | null
  notificationSummary?: string | null
  notificationRemark?: string | null
  lastUpdatedUtc?: string | null
  departure?: AdbMovement | null
  arrival?: AdbMovement | null
}

/** The body AeroDataBox posts to the callback (FlightNotificationContract). */
export interface AdbNotification {
  flights?: AdbFlightItem[] | null
  subscription?: { id?: string | null } | null
  balance?: { creditsRemaining?: number | null } | null
}

/** "B6 1017", "b61017" → "B61017": the subject AeroDataBox is subscribed to. */
export function subjectFor(airline: string, flightNumber: string): string {
  return `${airline}${flightNumber}`.toUpperCase().replace(/\s+/g, '')
}

/** A flight number for comparing: no spaces, upper case, no leading zeros on the number ("DL 047" = "DL47"). */
export function canonNumber(value: string): string {
  const t = value.toUpperCase().replace(/\s+/g, '')
  const m = /^([A-Z0-9]{2})(\d+)([A-Z]?)$/.exec(t)
  return m ? `${m[1]}${Number(m[2])}${m[3]}` : t
}

/** AeroDataBox writes UTC times like "2033-02-01 14:05Z". */
export function parseUtc(value: string | null | undefined): Date | null {
  if (!value) return null
  const d = new Date(value.trim().replace(' ', 'T'))
  return Number.isNaN(d.getTime()) ? null : d
}

const best = (m: AdbMovement | null | undefined): Date | null =>
  parseUtc(m?.runwayTime?.utc) ??
  parseUtc(m?.revisedTime?.utc) ??
  parseUtc(m?.predictedTime?.utc) ??
  parseUtc(m?.scheduledTime?.utc)

const TERMINAL_STATUSES = ['Arrived', 'Canceled', 'CanceledUncertain'] as const

/** True once nothing more will happen to the flight: it landed or was cancelled. */
export function isFinal(status: string | null | undefined): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status ?? '')
}

/** How far a push's scheduled departure may be from the booking and still be the same flight. */
const MATCH_WINDOW_MS = 3 * 60 * 60 * 1000

/**
 * Whether a pushed flight is the booked one. The number must match, the
 * airports must match where the push names them, and the scheduled departure
 * must be within a few hours (the same number flies again the next day).
 */
export function matchesFlight(item: AdbFlightItem, f: FlightSpec): boolean {
  if (!item.number || canonNumber(item.number) !== canonNumber(`${f.airline}${f.flightNumber}`)) return false
  const from = item.departure?.airport?.iata
  const to = item.arrival?.airport?.iata
  if (from && from.toUpperCase() !== f.fromAirport.toUpperCase()) return false
  if (to && to.toUpperCase() !== f.toAirport.toUpperCase()) return false
  const scheduled = parseUtc(item.departure?.scheduledTime?.utc)
  if (scheduled) return Math.abs(scheduled.getTime() - f.scheduledDeparture.getTime()) <= MATCH_WINDOW_MS
  // No time in the push: only a full route match counts.
  return !!from && !!to
}

/** The newest of the pushed items that match the booked flight, if any. */
export function pickMatch(items: readonly AdbFlightItem[], f: FlightSpec): AdbFlightItem | null {
  const matching = items.filter((i) => matchesFlight(i, f))
  matching.sort((a, b) => (parseUtc(b.lastUpdatedUtc)?.getTime() ?? 0) - (parseUtc(a.lastUpdatedUtc)?.getTime() ?? 0))
  return matching[0] ?? null
}

/** A pushed flight in the app's own terms, the same shape the simulated feed gives. */
export function toLiveState(item: AdbFlightItem, f: FlightSpec): LiveState {
  const departure = best(item.departure) ?? f.scheduledDeparture
  const arrival = best(item.arrival) ?? f.scheduledArrival
  let status: LiveStatus
  switch (item.status) {
    case 'Canceled':
    case 'CanceledUncertain':
      status = 'cancelled'
      break
    case 'Arrived':
      status = 'landed'
      break
    case 'Departed':
    case 'EnRoute':
    case 'Approaching':
    case 'Diverted':
      status = 'departed'
      break
    default:
      status =
        item.status === 'Delayed' || arrival.getTime() - f.scheduledArrival.getTime() >= 5 * 60_000
          ? 'delayed'
          : 'scheduled'
  }
  // Gate and terminal at the theater's end of the trip.
  const theaterEnd = f.direction === 'arrival' || f.toAirport === THEATRE_AIRPORT ? item.arrival : item.departure
  return {
    status,
    departure,
    arrival,
    gate: theaterEnd?.gate ?? null,
    terminal: theaterEnd?.terminal
      ? /^\d+$/.test(theaterEnd.terminal)
        ? `Terminal ${theaterEnd.terminal}`
        : theaterEnd.terminal
      : null,
    baggage: f.direction === 'arrival' && status === 'landed' ? (item.arrival?.baggageBelt ?? null) : null,
  }
}

/** A random callback token, and the hash the database keeps instead of it. */
export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export interface AdbClient {
  subscribe(subject: string, callbackUrl: string): Promise<{ id: string }>
  /** Removing is free. A subscription that's already gone counts as removed. */
  unsubscribe(id: string): Promise<void>
  /** Credits left, shared by all subscriptions. Free to call. */
  balance(): Promise<number | null>
  /**
   * Adds credits to the shared balance. Each credit uses one API unit from the
   * plan, and AeroDataBox caps how many can be added at once. Returns the new
   * balance when the reply gives it.
   */
  refill(credits: number): Promise<number | null>
}

/**
 * Reads the credit count from a balance reply. The guide names the field
 * creditsRemaining (pushes carry it under balance); the other names are
 * accepted in case the balance endpoints word it differently.
 */
export function readCredits(json: unknown): number | null {
  if (!json || typeof json !== 'object') return null
  const o = json as Record<string, unknown>
  for (const key of ['creditsRemaining', 'credits', 'balance', 'creditsBalance']) {
    if (typeof o[key] === 'number') return o[key]
  }
  return null
}

/** Failed calls report the status only, never the key or the response body. */
/**
 * Reads a balance reply. Returns null for an empty reply (204 or no body),
 * and logs the shape of a reply it can't read so the field name can be fixed.
 */
async function readBalanceReply(res: Response, what: string): Promise<number | null> {
  if (res.status === 204) return null
  const text = await res.text().catch(() => '')
  if (!text.trim()) return null
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  const credits = readCredits(json)
  if (credits === null) {
    const keys = json && typeof json === 'object' ? Object.keys(json).join(',') : typeof json
    console.warn(
      `AeroDataBox ${what} reply had no credit count (HTTP ${res.status}, ${res.headers.get('content-type') ?? 'no type'}, keys: ${keys})`,
    )
    // An unreadable balance is not the same as an empty one. A refill that
    // went through still counts; the caller reads the balance again.
    if (what === 'balance') throw new AdbError(res.status, `${what} (unreadable reply)`)
  }
  return credits
}

export class AdbError extends Error {
  constructor(
    readonly status: number,
    what: string,
  ) {
    super(`AeroDataBox ${what} failed with HTTP ${status}`)
  }
}

export function adbClient(apiKey: string, fetchImpl: typeof fetch = fetch): AdbClient {
  const call = async (method: string, path: string, body?: unknown) =>
    fetchImpl(`${ADB_BASE_URL}${path}`, {
      method,
      headers: {
        'X-Api-Key': apiKey,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
  return {
    async subscribe(subject, callbackUrl) {
      const res = await call('POST', `/subscriptions/webhook/FlightByNumber/${encodeURIComponent(subject)}`, {
        url: callbackUrl,
        // One retry if the callback is slow or down; each costs a credit.
        maxDeliveryRetries: 1,
      })
      if (!res.ok) throw new AdbError(res.status, 'subscribe')
      const json = (await res.json()) as { id?: string }
      if (!json.id) throw new AdbError(res.status, 'subscribe (no id)')
      return { id: json.id }
    },
    async unsubscribe(id) {
      const res = await call('DELETE', `/subscriptions/webhook/${encodeURIComponent(id)}`)
      if (!res.ok && res.status !== 404) throw new AdbError(res.status, 'unsubscribe')
    },
    async balance() {
      const res = await call('GET', '/subscriptions/balance')
      if (!res.ok) throw new AdbError(res.status, 'balance')
      // An account that has never been topped up has no balance yet, and
      // AeroDataBox answers with no body. That's zero credits, not unknown.
      return (await readBalanceReply(res, 'balance')) ?? 0
    },
    async refill(credits) {
      const res = await call('POST', '/subscriptions/balance/refill', { credits })
      if (!res.ok) throw new AdbError(res.status, 'refill')
      return readBalanceReply(res, 'refill')
    },
  }
}
