import { and, eq, gte, inArray, isNull, lt, lte, notInArray, or } from 'drizzle-orm'
import type { FlightEventKind } from '../../shared/travel.js'
import { minutesBetween } from '../../shared/time.js'
import type { Db } from '../db/client.js'
import { demoClock, flight, flightEvent } from '../db/schema.js'
import type { FlightStatusProvider, LiveState } from './provider.js'

/** The demo clock's offset from real time. Zero unless someone moved it. */
export async function clockOffsetMs(db: Db): Promise<number> {
  const [row] = await db.select({ offsetMs: demoClock.offsetMs }).from(demoClock).limit(1)
  return row?.offsetMs ?? 0
}

/** "Now" as the feed sees it: real time, plus the demo clock's offset when the feed follows it. */
export async function feedNow(db: Db, provider: FlightStatusProvider, real = new Date()): Promise<Date> {
  if (!provider.usesDemoClock) return real
  return new Date(real.getTime() + (await clockOffsetMs(db)))
}

/**
 * Moves the demo clock. Live status is cleared everywhere, because what the
 * feed said at another moment no longer holds; the next look at the board
 * fills it in for the new moment.
 */
export async function setDemoClock(db: Db, offsetMs: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(demoClock)
      .values({ id: true, offsetMs })
      .onConflictDoUpdate({ target: demoClock.id, set: { offsetMs } })
    await tx.delete(flightEvent)
    await tx.update(flight).set({
      liveStatus: null,
      liveDeparture: null,
      liveArrival: null,
      liveGate: null,
      liveTerminal: null,
      liveBaggage: null,
      liveCheckedAt: null,
    })
  })
}

type FlightRow = typeof flight.$inferSelect

interface Change {
  kind: FlightEventKind
  detail?: Record<string, unknown>
}

/** What changed between the last answer and this one, as alerts. The first answer only reports bad news. */
export function changesBetween(before: FlightRow, next: LiveState): Change[] {
  const out: Change[] = []
  const first = before.liveStatus === null
  if (next.status === 'cancelled') {
    if (before.liveStatus !== 'cancelled') out.push({ kind: 'cancelled' })
    return out
  }
  const late = minutesBetween(before.scheduledArrival, next.arrival)
  const wasLate = before.liveArrival ? minutesBetween(before.scheduledArrival, before.liveArrival) : 0
  // A new or bigger delay of five minutes or more.
  if (late >= 5 && late - wasLate >= 5) out.push({ kind: 'delayed', detail: { minutes: late } })
  if (!first && before.liveGate && next.gate && before.liveGate !== next.gate) {
    out.push({ kind: 'gate_change', detail: { from: before.liveGate, to: next.gate } })
  }
  if (!first && next.status === 'departed' && before.liveStatus !== 'departed') out.push({ kind: 'departed' })
  if (next.status === 'landed' && before.liveStatus !== 'landed') {
    out.push({ kind: 'landed', detail: next.baggage ? { baggage: next.baggage } : undefined })
  }
  return out
}

export interface TrackResult {
  checked: number
  events: number
}

/**
 * The flight tracker: asks the feed about flights in the air or due within
 * the day, writes only the live columns, and logs what changed. Each flight is
 * claimed first (by stamping live_checked_at), so two people refreshing the
 * board at once can't both log the same change.
 *
 * The plan runs this from a scheduled job (Inngest) with push alerts; until
 * that's set up it runs when someone looks at the board.
 */
export async function trackFlights(db: Db, provider: FlightStatusProvider, now: Date): Promise<TrackResult> {
  const windowStart = new Date(now.getTime() - 6 * 3_600_000)
  const windowEnd = new Date(now.getTime() + 24 * 3_600_000)
  const staleBefore = new Date(now.getTime() - provider.minIntervalMs)

  const due = await db
    .select({ id: flight.id })
    .from(flight)
    .where(
      and(
        lte(flight.scheduledDeparture, windowEnd),
        gte(flight.scheduledArrival, windowStart),
        or(isNull(flight.liveStatus), notInArray(flight.liveStatus, ['landed', 'cancelled'])),
        or(isNull(flight.liveCheckedAt), lt(flight.liveCheckedAt, staleBefore)),
      ),
    )
  if (!due.length) return { checked: 0, events: 0 }

  // Claim: only rows still stale at this instant come back, and they're ours.
  const claimed = await db
    .update(flight)
    .set({ liveCheckedAt: now })
    .where(
      and(
        inArray(
          flight.id,
          due.map((d) => d.id),
        ),
        or(isNull(flight.liveCheckedAt), lt(flight.liveCheckedAt, staleBefore)),
      ),
    )
    .returning()

  let events = 0
  for (const row of claimed) {
    const state = await provider.status(row, now)
    if (!state) continue
    const changes = changesBetween(row, state)
    await db.transaction(async (tx) => {
      await tx
        .update(flight)
        .set({
          liveStatus: state.status,
          liveDeparture: state.departure,
          liveArrival: state.arrival,
          liveGate: state.gate,
          liveTerminal: state.terminal,
          liveBaggage: state.baggage,
        })
        .where(eq(flight.id, row.id))
      if (changes.length) {
        await tx
          .insert(flightEvent)
          .values(changes.map((c) => ({ flightId: row.id, at: now, kind: c.kind, detail: c.detail ?? null })))
      }
    })
    events += changes.length
  }
  return { checked: claimed.length, events }
}
