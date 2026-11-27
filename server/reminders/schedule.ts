import { DIGEST_HOUR, PAPERWORK_HOUR } from '../../shared/reminders.js'
import { addDays, localDate, THEATRE_TZ, zonedToUtc } from '../../shared/time.js'

// When each automatic reminder is due. Plain functions of the dates, so the
// sleeping runs and the settings page agree, and tests need no database.

const pad = (n: number) => String(n).padStart(2, '0')

/** A theatre-time hour on a date, as an instant. */
export function atTheatreHour(date: string, hour: number): Date {
  return zonedToUtc(`${date}T${pad(hour)}:00`, THEATRE_TZ)
}

/** The next time the clock reads `hour` in theatre time, after `now`. */
export function nextTheatreHour(now: Date, hour: number): Date {
  const today = atTheatreHour(localDate(now, THEATRE_TZ), hour)
  return today.getTime() > now.getTime() ? today : atTheatreHour(addDays(localDate(now, THEATRE_TZ), 1), hour)
}

/**
 * When people on a production still missing forms get their automatic
 * reminder: 9 AM, `daysBefore` days before first rehearsal. If that moment
 * has passed (someone was added late, or the date moved), the next 9 AM, as
 * long as that is still before first rehearsal. Null when it's off, there's
 * no rehearsal date, or rehearsals have begun.
 */
export function paperworkReminderAt(rehearsalStart: string | null, daysBefore: number, now: Date): Date | null {
  if (!rehearsalStart || daysBefore <= 0) return null
  const target = atTheatreHour(addDays(rehearsalStart, -daysBefore), PAPERWORK_HOUR)
  if (target.getTime() > now.getTime()) return target
  const next = nextTheatreHour(now, PAPERWORK_HOUR)
  return localDate(next, THEATRE_TZ) < rehearsalStart ? next : null
}

/** 7 AM on a date: when that day's digest goes. */
export function digestAt(day: string): Date {
  return atTheatreHour(day, DIGEST_HOUR)
}

/** The day of the next digest after `now`: today before 7 AM, otherwise tomorrow. */
export function nextDigestDay(now: Date): string {
  return localDate(nextTheatreHour(now, DIGEST_HOUR), THEATRE_TZ)
}

/** The date a sent contract counts as late if it's still unsigned. Null when that reminder is off. */
export function contractLateOn(sentOn: string, daysAfter: number): string | null {
  return daysAfter > 0 ? addDays(sentOn, daysAfter) : null
}

/**
 * The digest that should first mention a contract still unsigned: the morning
 * it turns late, or the next digest if that morning has passed (it was marked
 * sent with an old date).
 */
export function contractDigestDay(sentOn: string, daysAfter: number, now: Date): string | null {
  const late = contractLateOn(sentOn, daysAfter)
  if (!late) return null
  return digestAt(late).getTime() > now.getTime() ? late : nextDigestDay(now)
}
