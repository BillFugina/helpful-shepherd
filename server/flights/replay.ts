import type { FlightEventKind } from '../../shared/travel.js'
import type { flight } from '../db/schema.js'
import { simulateStatus } from './provider.js'
import { changesBetween } from './track.js'

type FlightRow = typeof flight.$inferSelect
type LiveColumns = Pick<
  FlightRow,
  'liveStatus' | 'liveDeparture' | 'liveArrival' | 'liveGate' | 'liveTerminal' | 'liveBaggage' | 'liveCheckedAt'
>

export interface ReplayedEvent {
  at: Date
  kind: FlightEventKind
  detail: Record<string, unknown> | null
}

export interface Replayed {
  live: LiveColumns
  events: ReplayedEvent[]
}

const MIN = 60_000
const HOUR = 60 * MIN
/** How often the replay "checks" a flight. The real tracker checks at most once a minute. */
export const REPLAY_STEP_MS = 5 * MIN

const NOT_CHECKED: LiveColumns = {
  liveStatus: null,
  liveDeparture: null,
  liveArrival: null,
  liveGate: null,
  liveTerminal: null,
  liveBaggage: null,
  liveCheckedAt: null,
}

/**
 * What the board would show for a flight at `now` if the tracker had checked
 * it every few minutes, worked out from the simulated feed without touching
 * the database. Guests each get their own demo clock this way, so one visitor
 * moving time can't change what anyone else sees, and nothing is written.
 *
 * Follows trackFlights' rules: a flight is checked from 24 hours before it
 * leaves until 6 hours after it lands, and not again once it has landed or
 * been cancelled.
 */
export function replayFlight(row: FlightRow, now: Date): Replayed {
  const start = row.scheduledDeparture.getTime() - 24 * HOUR
  const stop = Math.min(now.getTime(), row.scheduledArrival.getTime() + 6 * HOUR)
  if (now.getTime() < start) return { live: NOT_CHECKED, events: [] }

  let before: FlightRow = { ...row, ...NOT_CHECKED }
  const events: ReplayedEvent[] = []
  const check = (t: number) => {
    const at = new Date(t)
    const state = simulateStatus(row, at)
    for (const c of changesBetween(before, state)) events.push({ at, kind: c.kind, detail: c.detail ?? null })
    before = {
      ...before,
      liveStatus: state.status,
      liveDeparture: state.departure,
      liveArrival: state.arrival,
      liveGate: state.gate,
      liveTerminal: state.terminal,
      liveBaggage: state.baggage,
      liveCheckedAt: at,
    }
  }
  const done = () => before.liveStatus === 'landed' || before.liveStatus === 'cancelled'
  for (let t = start; t < stop && !done(); t += REPLAY_STEP_MS) check(t)
  // One last look at the exact moment, so the board isn't a few minutes behind.
  if (!done() && stop >= start) check(stop)

  const { liveStatus, liveDeparture, liveArrival, liveGate, liveTerminal, liveBaggage, liveCheckedAt } = before
  return {
    live: { liveStatus, liveDeparture, liveArrival, liveGate, liveTerminal, liveBaggage, liveCheckedAt },
    events,
  }
}
