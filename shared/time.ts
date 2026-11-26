/**
 * Time zones without a library. Flight times are stored as instants and typed
 * and shown in the local time of the airport they belong to, so "lands 2:15
 * PM" means 2:15 PM in Raleigh whatever time zone the viewer's phone is in.
 */

/** Where the theater is. Rental cars, housing and "today" on the board use this zone. */
export const THEATRE_TZ = 'America/New_York'
export const THEATRE_AIRPORT = 'RDU'

interface Parts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(tz, f)
  }
  return f
}

function partsIn(date: Date, tz: string): Parts {
  const out: Record<string, number> = {}
  for (const p of formatter(tz).formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value)
  }
  return out as unknown as Parts
}

/** How far the zone is ahead of UTC at that instant, in milliseconds. */
function offsetMs(date: Date, tz: string): number {
  const p = partsIn(date, tz)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(date.getTime() / 1000) * 1000
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

/** True for "2027-01-10T14:15". */
export function isLocalDateTime(value: string): boolean {
  return LOCAL_RE.test(value)
}

/** "2027-01-10T14:15" in a zone to the instant it names. */
export function zonedToUtc(local: string, tz: string): Date {
  const m = LOCAL_RE.exec(local)
  if (!m) throw new Error(`Not a local date and time: ${local}`)
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]))
  const first = offsetMs(new Date(guess), tz)
  let t = guess - first
  const second = offsetMs(new Date(t), tz)
  if (second !== first) t = guess - second
  return new Date(t)
}

const pad = (n: number) => String(n).padStart(2, '0')

/** An instant as "2027-01-10T14:15" in a zone, the value a datetime-local input takes. */
export function utcToLocal(date: Date, tz: string): string {
  const p = partsIn(date, tz)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`
}

/** The calendar date ("2027-01-10") of an instant in a zone. */
export function localDate(date: Date, tz: string): string {
  return utcToLocal(date, tz).slice(0, 10)
}

/** Midnight at the start of a local date, and at the start of the next one. */
export function dayBounds(date: string, tz: string): { start: Date; end: Date } {
  return { start: zonedToUtc(`${date}T00:00`, tz), end: zonedToUtc(`${addDays(date, 1)}T00:00`, tz) }
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** "2:15 PM" in a zone. */
export function formatTime(date: Date, tz: string): string {
  return date.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })
}

/** "Sun, Jan 10" in a zone. */
export function formatDay(date: Date, tz: string): string {
  return date.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' })
}

/** Whole minutes from a to b (positive when b is later). */
export function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60_000)
}

// ---------------------------------------------------------------------------
// Airports. Enough to type a flight in local time; an airport that isn't here
// is refused with a clear message rather than guessed at.
// ---------------------------------------------------------------------------

export const AIRPORTS = {
  ABQ: { city: 'Albuquerque', tz: 'America/Denver' },
  ATL: { city: 'Atlanta', tz: 'America/New_York' },
  AUS: { city: 'Austin', tz: 'America/Chicago' },
  BDL: { city: 'Hartford', tz: 'America/New_York' },
  BNA: { city: 'Nashville', tz: 'America/Chicago' },
  BOS: { city: 'Boston', tz: 'America/New_York' },
  BUF: { city: 'Buffalo', tz: 'America/New_York' },
  BUR: { city: 'Burbank', tz: 'America/Los_Angeles' },
  BWI: { city: 'Baltimore', tz: 'America/New_York' },
  CHS: { city: 'Charleston', tz: 'America/New_York' },
  CLE: { city: 'Cleveland', tz: 'America/New_York' },
  CLT: { city: 'Charlotte', tz: 'America/New_York' },
  CMH: { city: 'Columbus', tz: 'America/New_York' },
  CVG: { city: 'Cincinnati', tz: 'America/New_York' },
  DAL: { city: 'Dallas Love Field', tz: 'America/Chicago' },
  DCA: { city: 'Washington National', tz: 'America/New_York' },
  DEN: { city: 'Denver', tz: 'America/Denver' },
  DFW: { city: 'Dallas/Fort Worth', tz: 'America/Chicago' },
  DTW: { city: 'Detroit', tz: 'America/Detroit' },
  EWR: { city: 'Newark', tz: 'America/New_York' },
  FLL: { city: 'Fort Lauderdale', tz: 'America/New_York' },
  GSO: { city: 'Greensboro', tz: 'America/New_York' },
  HNL: { city: 'Honolulu', tz: 'Pacific/Honolulu' },
  HOU: { city: 'Houston Hobby', tz: 'America/Chicago' },
  IAD: { city: 'Washington Dulles', tz: 'America/New_York' },
  IAH: { city: 'Houston', tz: 'America/Chicago' },
  IND: { city: 'Indianapolis', tz: 'America/Indiana/Indianapolis' },
  JAX: { city: 'Jacksonville', tz: 'America/New_York' },
  JFK: { city: 'New York JFK', tz: 'America/New_York' },
  LAS: { city: 'Las Vegas', tz: 'America/Los_Angeles' },
  LAX: { city: 'Los Angeles', tz: 'America/Los_Angeles' },
  LGA: { city: 'New York LaGuardia', tz: 'America/New_York' },
  MCI: { city: 'Kansas City', tz: 'America/Chicago' },
  MCO: { city: 'Orlando', tz: 'America/New_York' },
  MDW: { city: 'Chicago Midway', tz: 'America/Chicago' },
  MIA: { city: 'Miami', tz: 'America/New_York' },
  MKE: { city: 'Milwaukee', tz: 'America/Chicago' },
  MSP: { city: 'Minneapolis', tz: 'America/Chicago' },
  MSY: { city: 'New Orleans', tz: 'America/Chicago' },
  OAK: { city: 'Oakland', tz: 'America/Los_Angeles' },
  ORD: { city: "Chicago O'Hare", tz: 'America/Chicago' },
  ORF: { city: 'Norfolk', tz: 'America/New_York' },
  PDX: { city: 'Portland', tz: 'America/Los_Angeles' },
  PHL: { city: 'Philadelphia', tz: 'America/New_York' },
  PHX: { city: 'Phoenix', tz: 'America/Phoenix' },
  PIT: { city: 'Pittsburgh', tz: 'America/New_York' },
  PVD: { city: 'Providence', tz: 'America/New_York' },
  RDU: { city: 'Raleigh-Durham', tz: 'America/New_York' },
  RIC: { city: 'Richmond', tz: 'America/New_York' },
  RSW: { city: 'Fort Myers', tz: 'America/New_York' },
  SAN: { city: 'San Diego', tz: 'America/Los_Angeles' },
  SAT: { city: 'San Antonio', tz: 'America/Chicago' },
  SAV: { city: 'Savannah', tz: 'America/New_York' },
  SEA: { city: 'Seattle', tz: 'America/Los_Angeles' },
  SFO: { city: 'San Francisco', tz: 'America/Los_Angeles' },
  SJC: { city: 'San Jose', tz: 'America/Los_Angeles' },
  SLC: { city: 'Salt Lake City', tz: 'America/Denver' },
  STL: { city: 'St. Louis', tz: 'America/Chicago' },
  TPA: { city: 'Tampa', tz: 'America/New_York' },
  TYS: { city: 'Knoxville', tz: 'America/New_York' },
  YUL: { city: 'Montreal', tz: 'America/Toronto' },
  YYZ: { city: 'Toronto', tz: 'America/Toronto' },
  LHR: { city: 'London Heathrow', tz: 'Europe/London' },
} as const satisfies Record<string, { city: string; tz: string }>

export type AirportCode = keyof typeof AIRPORTS

export function isKnownAirport(code: string): code is AirportCode {
  return Object.hasOwn(AIRPORTS, code)
}

export function airportTz(code: string): string {
  if (!isKnownAirport(code)) throw new Error(`Unknown airport ${code}`)
  return AIRPORTS[code].tz
}
