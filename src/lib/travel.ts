import { airportTz, formatDay, formatTime, minutesBetween, THEATRE_TZ, utcToLocal } from '../../shared/time'
import { LIVE_STATUS_LABELS, type LiveStatus } from '../../shared/travel'

export { airportTz, formatDay, formatTime, THEATRE_TZ, utcToLocal }

/** "2:15 PM" at an airport. */
export function timeAt(date: Date | null | undefined, airport: string): string {
  return date ? formatTime(date, airportTz(airport)) : '–'
}

/** "Sun, Jan 10" at an airport. */
export function dayAt(date: Date | null | undefined, airport: string): string {
  return date ? formatDay(date, airportTz(airport)) : '–'
}

interface FlightLike {
  scheduledDeparture: Date
  scheduledArrival: Date
  liveStatus: LiveStatus | null
  liveDeparture: Date | null
  liveArrival: Date | null
}

export type Tone = 'neutral' | 'good' | 'warn' | 'bad'

/**
 * What the board says about a flight in a few words, and how loudly. Before
 * the feed has looked at a flight, it's just "Scheduled".
 */
export function flightStatus(f: FlightLike): { label: string; tone: Tone } {
  if (!f.liveStatus) return { label: 'Scheduled', tone: 'neutral' }
  if (f.liveStatus === 'cancelled') return { label: 'Cancelled', tone: 'bad' }
  const late = f.liveArrival ? minutesBetween(f.scheduledArrival, f.liveArrival) : 0
  if (f.liveStatus === 'landed') {
    return late >= 15 ? { label: `Landed ${late} min late`, tone: 'warn' } : { label: 'Landed', tone: 'good' }
  }
  if (late >= 15) return { label: `${LIVE_STATUS_LABELS[f.liveStatus]}, ${late} min late`, tone: 'warn' }
  if (late <= -5) return { label: `${LIVE_STATUS_LABELS[f.liveStatus]}, ${-late} min early`, tone: 'good' }
  return { label: f.liveStatus === 'departed' ? 'In the air' : 'On time', tone: 'good' }
}

/** The expected time: what the feed says if it has looked, otherwise the schedule. */
export function expectedArrival(f: FlightLike): Date {
  return f.liveArrival ?? f.scheduledArrival
}
export function expectedDeparture(f: FlightLike): Date {
  return f.liveDeparture ?? f.scheduledDeparture
}

/** A phone number as a tel: or sms: link target, digits only. */
export function phoneHref(kind: 'tel' | 'sms', cell: string): string {
  return `${kind}:${cell.replace(/[^\d+]/g, '')}`
}
