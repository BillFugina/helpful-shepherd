import { THEATRE_TZ, localDate } from '../../shared/time.js'
import type {
  FLIGHT_FIELDS,
  HOUSING_ASSIGNMENT_FIELDS,
  HOUSING_PREFERENCE_FIELDS,
  HOUSING_ROOM_FIELDS,
  HOUSING_UNIT_FIELDS,
  RENTAL_CAR_FIELDS,
} from '../../shared/travel.js'
import type { flight, housingAssignment, housingPreference, housingRoom, housingUnit, rentalCar } from '../db/schema.js'
import type { RecordOf } from '../roster/records.js'

/* Rows shaped for filterRecord, written out field by field (see roster/records.ts). */

export type FlightRecord = RecordOf<typeof flight.$inferSelect, typeof FLIGHT_FIELDS>
export type RentalCarRecord = RecordOf<typeof rentalCar.$inferSelect, typeof RENTAL_CAR_FIELDS>
export type HousingUnitRecord = RecordOf<typeof housingUnit.$inferSelect, typeof HOUSING_UNIT_FIELDS>
export type HousingRoomRecord = RecordOf<typeof housingRoom.$inferSelect, typeof HOUSING_ROOM_FIELDS>
export type HousingAssignmentRecord = RecordOf<typeof housingAssignment.$inferSelect, typeof HOUSING_ASSIGNMENT_FIELDS>
export type HousingPreferenceRecord = RecordOf<typeof housingPreference.$inferSelect, typeof HOUSING_PREFERENCE_FIELDS>

export function flightRecord(r: typeof flight.$inferSelect): FlightRecord {
  return {
    id: r.id,
    engagementId: r.engagementId,
    direction: r.direction,
    airline: r.airline,
    flightNumber: r.flightNumber,
    fromAirport: r.fromAirport,
    toAirport: r.toAirport,
    scheduledDeparture: r.scheduledDeparture,
    scheduledArrival: r.scheduledArrival,
    confirmation: r.confirmation,
    bookingSource: r.bookingSource,
    notes: r.notes,
    liveStatus: r.liveStatus,
    liveDeparture: r.liveDeparture,
    liveArrival: r.liveArrival,
    liveGate: r.liveGate,
    liveTerminal: r.liveTerminal,
    liveBaggage: r.liveBaggage,
    liveCheckedAt: r.liveCheckedAt,
  }
}

export function rentalCarRecord(r: typeof rentalCar.$inferSelect): RentalCarRecord {
  return {
    id: r.id,
    engagementId: r.engagementId,
    company: r.company,
    confirmation: r.confirmation,
    pickupAt: r.pickupAt,
    pickupPlace: r.pickupPlace,
    returnAt: r.returnAt,
    returnPlace: r.returnPlace,
    notes: r.notes,
  }
}

export function housingUnitRecord(r: typeof housingUnit.$inferSelect): HousingUnitRecord {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    address: r.address,
    accessNotes: r.accessNotes,
    doorCode: r.doorCode,
    notes: r.notes,
  }
}

export function housingRoomRecord(r: typeof housingRoom.$inferSelect): HousingRoomRecord {
  return { id: r.id, unitId: r.unitId, name: r.name, floor: r.floor, bathroom: r.bathroom }
}

export function housingAssignmentRecord(r: typeof housingAssignment.$inferSelect): HousingAssignmentRecord {
  return { id: r.id, engagementId: r.engagementId, roomId: r.roomId, startsOn: r.startsOn, endsOn: r.endsOn }
}

export function housingPreferenceRecord(r: typeof housingPreference.$inferSelect): HousingPreferenceRecord {
  return { id: r.id, personId: r.personId, rule: r.rule, note: r.note }
}

/** The name the app calls someone by in warnings and on the board. */
export function shortName(p: { legalName: string; preferredName: string | null }): string {
  return p.preferredName ?? p.legalName
}

/**
 * When someone gets to town and leaves, from their flights, as theater-local
 * dates: the last arriving leg's landing and the first leg home.
 */
export function travelDates(
  flights: readonly { direction: 'arrival' | 'departure'; scheduledArrival: Date; scheduledDeparture: Date }[],
): { arrivesOn?: string; leavesOn?: string } {
  let lands: Date | undefined
  let leaves: Date | undefined
  for (const f of flights) {
    if (f.direction === 'arrival' && (!lands || f.scheduledArrival > lands)) lands = f.scheduledArrival
    if (f.direction === 'departure' && (!leaves || f.scheduledDeparture < leaves)) leaves = f.scheduledDeparture
  }
  return {
    arrivesOn: lands ? localDate(lands, THEATRE_TZ) : undefined,
    leavesOn: leaves ? localDate(leaves, THEATRE_TZ) : undefined,
  }
}
