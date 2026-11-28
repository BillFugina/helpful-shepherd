/**
 * The guided tour of the guest demo: about a minute, one stop per thing the
 * app does best. Pure data and helpers here, so tests can check them; the saved state is
 * src/lib/tour.ts and the panel src/components/GuidedTour.tsx.
 *
 * Stops that need a real record (the season, a filled contract) name a
 * `place`; the panel looks the record up when it gets there and falls back to
 * `path` if it can't.
 */

export type TourPlace = 'season' | 'contract' | 'documents'

export type TourStep = {
  id: string
  title: string
  body: string
  /** Where the stop happens. Omitted: stay on whatever page is showing. */
  path?: string
  /** A page that depends on the demo data, looked up when the stop opens. */
  place?: TourPlace
  /** The data-tour name of the part of the page to point at. */
  target?: string
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'welcome',
    title: 'A one-minute tour',
    body: 'This is a company management app for a regional theater, filled with a made-up 2027 season. Use Next to walk through the best parts, or close the tour and look around on your own.',
    path: '/',
  },
  {
    id: 'season',
    title: 'The whole season at a glance',
    body: 'Every production, everyone contracted on it, and where each person is, from offer accepted to departed.',
    path: '/seasons',
    place: 'season',
    target: 'season-production',
  },
  {
    id: 'arrivals',
    title: 'Travel day, live',
    body: 'The arrivals board runs on your own demo clock with a simulated flight feed. Start the travel day and step forward an hour to watch a delay and a gate change come in. In production it uses live flight data from AeroDataBox, and staff get a phone alert when a flight changes.',
    path: '/arrivals',
    target: 'arrivals-clock',
  },
  {
    id: 'housing',
    title: 'Who sleeps where',
    body: 'Every place and every stay on one timeline, with a warning when a room breaks someone’s housing needs or a flight lands before their stay starts.',
    path: '/housing',
    target: 'housing-check',
  },
  {
    id: 'contracts',
    title: 'Contracts that fill themselves',
    body: 'Union contracts are filled straight from the roster and the deal, including Equity’s locked PDF form, and blank required fields are caught before anything goes out. Staff email the filled PDF to the artist and copy their agent in one step.',
    path: '/contracts/settings',
    place: 'contract',
    target: 'contract-fields',
  },
  {
    id: 'documents',
    title: 'Paperwork without the chasing',
    body: 'Each person’s checklist of tax and payroll forms. Forms come in through private upload links and are stored encrypted, which is why you see statuses but never the files.',
    path: '/documents',
    place: 'documents',
    target: 'documents-checklist',
  },
  {
    id: 'reminders',
    title: 'Reminders that send themselves',
    body: 'Missing forms are chased automatically. Each reminder is planned as a background job the moment its date is saved, so nothing checks on a timer, and the Company Manager gets a morning digest.',
    path: '/settings/reminders',
    target: 'reminders-coming-up',
  },
  {
    id: 'staff',
    title: 'Behind the staff login',
    body: 'Staff sign in with a password and an authenticator app. Field-level permissions mean Finance sees only what Finance needs, opening a private field is written to an audit log, the Company Manager can export everything, and a Claude connector lets Claude look up the roster and draft new entries for review. Built with React, tRPC, Drizzle on Postgres, Better Auth, Inngest and Vercel.',
  },
]

// ---------------------------------------------------------------------------
// The saved place in the tour (kept per browser tab by src/lib/tour.ts).
// ---------------------------------------------------------------------------

export type TourState = { open: boolean; step: number }

/** Reads a saved state, keeping the step in range. Anything unreadable counts as seen and closed. */
export function parseTourState(raw: string): TourState {
  try {
    const v: unknown = JSON.parse(raw)
    if (v && typeof v === 'object') {
      const { open, step } = v as Record<string, unknown>
      return { open: open === true, step: clampStep(typeof step === 'number' ? step : 0) }
    }
  } catch {
    // fall through
  }
  return { open: false, step: 0 }
}

/** The stop at this index, kept in range. */
export function tourStep(step: number): TourStep {
  const s = TOUR_STEPS[clampStep(step)]
  if (!s) throw new Error('The tour has no stops.')
  return s
}

export function clampStep(step: number): number {
  if (!Number.isFinite(step)) return 0
  return Math.min(Math.max(Math.trunc(step), 0), TOUR_STEPS.length - 1)
}

// ---------------------------------------------------------------------------
// Picking the records to show.
// ---------------------------------------------------------------------------

type ContractRow = { id: string; status?: string | null; template: { format: string } }

/**
 * The contract that shows the app best: an Equity one (the locked PDF form)
 * if there is one, then an SDC one, then any. Void contracts are skipped.
 */
export function pickShowcaseContract(engagements: { contracts: ContractRow[] }[]): string | null {
  const all = engagements.flatMap((e) => e.contracts).filter((c) => c.status !== 'void')
  const rank = (c: ContractRow) =>
    c.template.format === 'equity_itc_form' ? 0 : c.template.format === 'sdc_form' ? 1 : 2
  const best = [...all].sort((a, b) => rank(a) - rank(b))[0]
  return best?.id ?? null
}
