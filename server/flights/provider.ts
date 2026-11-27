import { THEATRE_AIRPORT } from '../../shared/time.js'
import type { FlightDirection, LiveStatus } from '../../shared/travel.js'

/** What a feed needs to know about a booked flight. */
export interface FlightSpec {
  direction: FlightDirection
  airline: string
  flightNumber: string
  fromAirport: string
  toAirport: string
  scheduledDeparture: Date
  scheduledArrival: Date
}

/** What a feed says about a flight right now. Times are estimated, or actual once they've happened. */
export interface LiveState {
  status: LiveStatus
  departure: Date
  arrival: Date
  /** The gate at the theater's end: where they land, or where they leave from. */
  gate: string | null
  terminal: string | null
  /** Baggage claim, once an arrival has landed. */
  baggage: string | null
}

/**
 * The flight-status adapter. Features talk only to this, so the simulated
 * demo feed and a paid one (AeroDataBox, per the plan) can be swapped without
 * touching them. `null` means the feed has nothing on the flight.
 */
export interface FlightStatusProvider {
  readonly name: 'simulated' | 'aerodatabox'
  /** True when the feed follows the demo clock instead of the real one. */
  readonly usesDemoClock: boolean
  /** How long to wait before asking about the same flight again. */
  readonly minIntervalMs: number
  status(flight: FlightSpec, asOf: Date): Promise<LiveState | null>
}

// ---------------------------------------------------------------------------
// The simulated feed. Deterministic: the same flight at the same moment always
// gives the same answer. What happens to a flight depends on the last digit
// of its number, so a demo can pick its drama:
//   9 cancelled, 7 late by 45 min, 4 late by 95 min, 3 gate change,
//   1 lands 12 min early, anything else on time.
// ---------------------------------------------------------------------------

const MIN = 60_000
const HOUR = 60 * MIN

export type Scenario =
  | { kind: 'on_time' }
  | { kind: 'early'; minutes: number }
  | { kind: 'delayed'; minutes: number }
  | { kind: 'gate_change' }
  | { kind: 'cancelled' }

export function scenarioFor(flightNumber: string): Scenario {
  const digits = flightNumber.replace(/\D/g, '')
  switch (digits.at(-1)) {
    case '9':
      return { kind: 'cancelled' }
    case '7':
      return { kind: 'delayed', minutes: 45 }
    case '4':
      return { kind: 'delayed', minutes: 95 }
    case '3':
      return { kind: 'gate_change' }
    case '1':
      return { kind: 'early', minutes: 12 }
    default:
      return { kind: 'on_time' }
  }
}

function hash(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** RDU-style gates: Terminal 1 has A gates, Terminal 2 has C gates. */
function gateFor(seed: number, shift = 0): { terminal: string; gate: string } {
  const t1 = seed % 3 === 0
  return { terminal: t1 ? 'Terminal 1' : 'Terminal 2', gate: `${t1 ? 'A' : 'C'}${1 + ((seed + shift) % 25)}` }
}

export function simulateStatus(f: FlightSpec, asOf: Date): LiveState {
  const scenario = scenarioFor(f.flightNumber)
  const seed = hash(`${f.airline}${f.flightNumber}${f.scheduledDeparture.toISOString()}`)
  const t = asOf.getTime()
  const dep = f.scheduledDeparture.getTime()
  const arr = f.scheduledArrival.getTime()
  // The theater's end of the trip: gates are known there about 3 hours ahead.
  const theaterEnd = f.toAirport === THEATRE_AIRPORT || f.direction === 'arrival' ? arr : dep
  const isArrival = f.direction === 'arrival'

  const delay = scenario.kind === 'delayed' ? scenario.minutes * MIN : 0
  const early = scenario.kind === 'early' ? scenario.minutes * MIN : 0
  const delayKnown = scenario.kind === 'delayed' && t >= dep - 2 * HOUR
  const departure = new Date(dep + (delayKnown ? delay : 0))
  // An early arrival only shows once the plane is in the air.
  const arrival = new Date(arr + (delayKnown ? delay : 0) - (t >= dep ? early : 0))

  const base = gateFor(seed)
  const gateChanged = scenario.kind === 'gate_change' && t >= theaterEnd - HOUR
  const gateKnown = t >= theaterEnd - 3 * HOUR
  const gate = gateKnown ? (gateChanged ? gateFor(seed, 7).gate : base.gate) : null
  const terminal = gateKnown ? base.terminal : null

  if (scenario.kind === 'cancelled' && t >= dep - 3 * HOUR) {
    return {
      status: 'cancelled',
      departure: f.scheduledDeparture,
      arrival: f.scheduledArrival,
      gate: null,
      terminal: null,
      baggage: null,
    }
  }
  if (t >= arrival.getTime()) {
    return {
      status: 'landed',
      departure,
      arrival,
      gate,
      terminal,
      baggage: isArrival ? String(1 + (seed % 9)) : null,
    }
  }
  if (t >= departure.getTime()) return { status: 'departed', departure, arrival, gate, terminal, baggage: null }
  return { status: delayKnown ? 'delayed' : 'scheduled', departure, arrival, gate, terminal, baggage: null }
}

export const simulatedProvider: FlightStatusProvider = {
  name: 'simulated',
  usesDemoClock: true,
  minIntervalMs: MIN,
  status: (flight, asOf) => Promise.resolve(simulateStatus(flight, asOf)),
}

/**
 * AeroDataBox pushes changes to /api/flight-push instead of being asked, so
 * there's nothing to poll: the board never runs the tracker with this feed.
 */
export const pushProvider: FlightStatusProvider = {
  name: 'aerodatabox',
  usesDemoClock: false,
  minIntervalMs: Number.POSITIVE_INFINITY,
  status: () => Promise.resolve(null),
}

/** True when booked flights are tracked by AeroDataBox pushes (FLIGHT_FEED=aerodatabox with a key). */
export function pushFeedOn(e: NodeJS.ProcessEnv = process.env): boolean {
  return e.FLIGHT_FEED === 'aerodatabox' && !!e.AERODATABOX_API_KEY
}

/**
 * The feed this deployment uses: the simulated one for the demo, or
 * AeroDataBox pushes when FLIGHT_FEED=aerodatabox and a key is set.
 */
export function flightProvider(): FlightStatusProvider {
  return pushFeedOn() ? pushProvider : simulatedProvider
}
