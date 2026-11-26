/**
 * Arrivals: flights, rental cars, housing and the live flight status that
 * drives the arrivals board. Shared by the server, which enforces the field
 * registries, and the client, which uses the labels and input schemas.
 * Source: the build plan's data model and slice 3.
 */
import { z } from 'zod'
import type { FieldMap } from './access.js'
import { addDays, isKnownAirport, isLocalDateTime } from './time.js'

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** An arrival comes to the theater; a departure leaves it. */
export const FLIGHT_DIRECTIONS = ['arrival', 'departure'] as const
export type FlightDirection = (typeof FLIGHT_DIRECTIONS)[number]
export const FLIGHT_DIRECTION_LABELS: Record<FlightDirection, string> = {
  arrival: 'Arriving',
  departure: 'Going home',
}

/** What the flight-status feed last said. Null on a flight means it hasn't been checked yet. */
export const LIVE_STATUSES = ['scheduled', 'delayed', 'departed', 'landed', 'cancelled'] as const
export type LiveStatus = (typeof LIVE_STATUSES)[number]
export const LIVE_STATUS_LABELS: Record<LiveStatus, string> = {
  scheduled: 'On schedule',
  delayed: 'Delayed',
  departed: 'In the air',
  landed: 'Landed',
  cancelled: 'Cancelled',
}

/** Changes the tracker noticed, shown as alerts on the board. */
export const FLIGHT_EVENT_KINDS = ['delayed', 'gate_change', 'departed', 'landed', 'cancelled'] as const
export type FlightEventKind = (typeof FLIGHT_EVENT_KINDS)[number]

export const HOUSING_KINDS = ['company_house', 'apartment', 'guesthouse', 'airbnb', 'hotel', 'other'] as const
export type HousingKind = (typeof HOUSING_KINDS)[number]
export const HOUSING_KIND_LABELS: Record<HousingKind, string> = {
  company_house: 'Company house',
  apartment: 'Apartment',
  guesthouse: 'Guesthouse',
  airbnb: 'Airbnb',
  hotel: 'Hotel',
  other: 'Other',
}

/** Housing rules a person has asked for. Breaking one shows a warning; it never blocks a save. */
export const HOUSING_RULES = ['private_bathroom', 'ground_floor'] as const
export type HousingRule = (typeof HOUSING_RULES)[number]
export const HOUSING_RULE_LABELS: Record<HousingRule, string> = {
  private_bathroom: "Won't share a bathroom",
  ground_floor: 'Needs a ground-floor room',
}

// ---------------------------------------------------------------------------
// Field registries
// ---------------------------------------------------------------------------

export const FLIGHT_FIELDS = {
  id: 'id',
  engagementId: 'id',
  direction: 'travel_logistics',
  airline: 'travel_logistics',
  flightNumber: 'travel_logistics',
  fromAirport: 'travel_logistics',
  toAirport: 'travel_logistics',
  scheduledDeparture: 'travel_logistics',
  scheduledArrival: 'travel_logistics',
  confirmation: 'travel_logistics',
  bookingSource: 'travel_logistics',
  notes: 'travel_logistics',
  // Written only by the flight tracker, never by a form.
  liveStatus: 'travel_logistics',
  liveDeparture: 'travel_logistics',
  liveArrival: 'travel_logistics',
  liveGate: 'travel_logistics',
  liveTerminal: 'travel_logistics',
  liveBaggage: 'travel_logistics',
  liveCheckedAt: 'travel_logistics',
} as const satisfies FieldMap

export const RENTAL_CAR_FIELDS = {
  id: 'id',
  engagementId: 'id',
  company: 'travel_logistics',
  confirmation: 'travel_logistics',
  pickupAt: 'travel_logistics',
  pickupPlace: 'travel_logistics',
  returnAt: 'travel_logistics',
  returnPlace: 'travel_logistics',
  notes: 'travel_logistics',
} as const satisfies FieldMap

export const HOUSING_UNIT_FIELDS = {
  id: 'id',
  name: 'housing_access',
  kind: 'housing_access',
  address: 'housing_access',
  accessNotes: 'housing_access',
  doorCode: 'housing_access',
  notes: 'housing_access',
} as const satisfies FieldMap

export const HOUSING_ROOM_FIELDS = {
  id: 'id',
  unitId: 'id',
  name: 'housing_access',
  floor: 'housing_access',
  bathroom: 'housing_access',
} as const satisfies FieldMap

export const HOUSING_ASSIGNMENT_FIELDS = {
  id: 'id',
  engagementId: 'id',
  roomId: 'id',
  startsOn: 'housing_access',
  endsOn: 'housing_access',
} as const satisfies FieldMap

export const HOUSING_PREFERENCE_FIELDS = {
  id: 'id',
  personId: 'id',
  rule: 'general',
  note: 'general',
} as const satisfies FieldMap

// ---------------------------------------------------------------------------
// Input schemas. Times are typed as local wall-clock time ("2027-01-10T14:15")
// at the place they belong to; the server turns them into instants.
// ---------------------------------------------------------------------------

const isoDate = z.iso.date()
const localDateTime = z.string().refine(isLocalDateTime, 'Enter a date and time.')
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v))
const airport = z
  .string()
  .trim()
  .toUpperCase()
  .refine((v) => /^[A-Z]{3}$/.test(v), 'Use the three-letter airport code, like RDU.')
  .refine(isKnownAirport, "The app doesn't know this airport's time zone yet. Add it to shared/time.ts.")

export const flightFields = z.object({
  direction: z.enum(FLIGHT_DIRECTIONS),
  airline: z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => /^[A-Z0-9]{2}$/.test(v), 'Use the two-character airline code, like AA or B6.'),
  flightNumber: z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => /^\d{1,4}[A-Z]?$/.test(v), 'Use the flight number only, like 1234.'),
  fromAirport: airport,
  toAirport: airport,
  /** Local time at the departure airport. */
  departLocal: localDateTime,
  /** Local time at the arrival airport. */
  arriveLocal: localDateTime,
  confirmation: optionalText(40),
  bookingSource: optionalText(120),
  notes: optionalText(1000),
})

export const addFlightInput = z
  .object({ engagementId: z.uuid() })
  .extend(flightFields.shape)
  .refine((v) => v.fromAirport !== v.toAirport, { path: ['toAirport'], message: 'Pick a different airport.' })
export const updateFlightInput = z
  .object({ id: z.uuid() })
  .extend(flightFields.shape)
  .refine((v) => v.fromAirport !== v.toAirport, { path: ['toAirport'], message: 'Pick a different airport.' })

/** Rental car times are local to the theater. */
export const rentalCarFields = z.object({
  company: z.string().trim().min(1).max(120),
  confirmation: optionalText(40),
  pickupLocal: localDateTime,
  pickupPlace: optionalText(200),
  returnLocal: localDateTime,
  returnPlace: optionalText(200),
  notes: optionalText(1000),
})
const carInOrder = (v: { pickupLocal: string; returnLocal: string }) => v.pickupLocal < v.returnLocal
export const addRentalCarInput = z
  .object({ engagementId: z.uuid() })
  .extend(rentalCarFields.shape)
  .refine(carInOrder, { path: ['returnLocal'], message: 'Return must be after pickup.' })
export const updateRentalCarInput = z
  .object({ id: z.uuid() })
  .extend(rentalCarFields.shape)
  .refine(carInOrder, { path: ['returnLocal'], message: 'Return must be after pickup.' })

export const housingUnitFields = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(HOUSING_KINDS),
  address: optionalText(300),
  accessNotes: optionalText(1000),
  doorCode: optionalText(40),
  notes: optionalText(1000),
})
export const updateHousingUnitInput = z.object({ id: z.uuid() }).extend(housingUnitFields.partial().shape)

export const housingRoomFields = z.object({
  name: z.string().trim().min(1).max(80),
  floor: z.number().int().min(0).max(50),
  /** Rooms in a unit with the same bathroom name share it. */
  bathroom: z.string().trim().min(1).max(80),
})
export const addHousingRoomInput = z.object({ unitId: z.uuid() }).extend(housingRoomFields.shape)
export const updateHousingRoomInput = z.object({ id: z.uuid() }).extend(housingRoomFields.partial().shape)

/** A stay runs from the first night (startsOn) to the morning they leave (endsOn). */
const stayInOrder = (v: { startsOn?: string; endsOn?: string }) => !v.startsOn || !v.endsOn || v.startsOn < v.endsOn
export const assignHousingInput = z
  .object({ engagementId: z.uuid(), roomId: z.uuid(), startsOn: isoDate, endsOn: isoDate })
  .refine(stayInOrder, { path: ['endsOn'], message: 'Move-out must be after move-in.' })
export const updateAssignmentInput = z
  .object({ id: z.uuid(), roomId: z.uuid().optional(), startsOn: isoDate.optional(), endsOn: isoDate.optional() })
  .refine(stayInOrder, { path: ['endsOn'], message: 'Move-out must be after move-in.' })

export const setPreferenceInput = z.object({
  personId: z.uuid(),
  rule: z.enum(HOUSING_RULES),
  note: optionalText(300),
})

export const boardInput = z.object({
  date: isoDate.optional(),
  /**
   * The guest demo's own clock: milliseconds from real time. Each guest keeps
   * theirs in the browser, and the server works the feed out for that moment
   * without saving anything. Staff use the shared demo clock and this is ignored.
   */
  clockOffsetMs: z
    .number()
    .int()
    .min(-10 * 365 * 86_400_000)
    .max(10 * 365 * 86_400_000)
    .optional(),
})
export const occupancyInput = z.object({ from: isoDate, days: z.number().int().min(1).max(62) })
export const setClockInput = z.object({ at: z.iso.datetime({ offset: true }) })

// ---------------------------------------------------------------------------
// Housing warnings. Pure, so the board, the calendar and the tests agree.
// ---------------------------------------------------------------------------

export interface StayForCheck {
  assignmentId: string
  engagementId: string
  personId: string
  personName: string
  unitId: string
  roomId: string
  roomName: string
  floor: number
  bathroom: string
  startsOn: string
  endsOn: string
}

export interface HousingWarning {
  assignmentId: string
  kind: HousingRule | 'arrives_before_housing' | 'leaves_after_housing'
  message: string
}

/** A calendar date as "Jun 14". */
function shortDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/** Two stays share a night: one starts before the other's move-out day. */
export function staysOverlap(a: { startsOn: string; endsOn: string }, b: { startsOn: string; endsOn: string }) {
  return a.startsOn < b.endsOn && b.startsOn < a.endsOn
}

/**
 * Warnings for each stay:
 * - a person who won't share a bathroom, in a room whose bathroom someone in
 *   another room uses on the same nights;
 * - a person who needs the ground floor, in a room above it;
 * - a flight that lands before the stay starts, or leaves after it ends.
 */
export function housingWarnings(
  stays: readonly StayForCheck[],
  rules: ReadonlyMap<string, readonly HousingRule[]>,
  travel: ReadonlyMap<string, { arrivesOn?: string; leavesOn?: string }> = new Map(),
): HousingWarning[] {
  const out: HousingWarning[] = []
  for (const s of stays) {
    const personRules = rules.get(s.personId) ?? []
    if (personRules.includes('private_bathroom')) {
      const sharers = stays.filter(
        (o) =>
          o.assignmentId !== s.assignmentId &&
          o.personId !== s.personId &&
          o.unitId === s.unitId &&
          o.roomId !== s.roomId &&
          o.bathroom === s.bathroom &&
          staysOverlap(o, s),
      )
      if (sharers.length) {
        out.push({
          assignmentId: s.assignmentId,
          kind: 'private_bathroom',
          message: `${s.personName} won't share a bathroom, but ${sharers.map((o) => o.personName).join(' and ')} also use${sharers.length === 1 ? 's' : ''} the ${s.bathroom}.`,
        })
      }
    }
    if (personRules.includes('ground_floor') && s.floor > 1) {
      out.push({
        assignmentId: s.assignmentId,
        kind: 'ground_floor',
        message: `${s.personName} needs a ground-floor room, but ${s.roomName} is on floor ${s.floor}.`,
      })
    }
    // Travel is checked against someone's first and last stay, so a split stay isn't flagged in the middle.
    const own = stays.filter((o) => o.engagementId === s.engagementId)
    const first = own.every((o) => o.startsOn >= s.startsOn)
    const last = own.every((o) => o.endsOn <= s.endsOn)
    const t = travel.get(s.engagementId)
    if (first && t?.arrivesOn && t.arrivesOn < s.startsOn) {
      out.push({
        assignmentId: s.assignmentId,
        kind: 'arrives_before_housing',
        message: `${s.personName} lands ${shortDate(t.arrivesOn)}, before housing starts ${shortDate(s.startsOn)}.`,
      })
    }
    // Leaving on the move-out day is fine; leaving later means a night with nowhere to stay.
    if (last && t?.leavesOn && t.leavesOn > s.endsOn) {
      out.push({
        assignmentId: s.assignmentId,
        kind: 'leaves_after_housing',
        message: `${s.personName} flies home ${shortDate(t.leavesOn)}, after housing ends ${shortDate(s.endsOn)}.`,
      })
    }
  }
  return out
}

/** The nights a stay covers inside a window, as dates. */
export function nightsIn(stay: { startsOn: string; endsOn: string }, from: string, days: number): string[] {
  const out: string[] = []
  for (let i = 0; i < days; i++) {
    const night = addDays(from, i)
    if (night >= stay.startsOn && night < stay.endsOn) out.push(night)
  }
  return out
}
