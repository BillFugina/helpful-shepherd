/** The guided tour's state in this browser tab, shared by the panel and the buttons that start it. */
import { clampStep, parseTourState, type TourState } from '../../shared/tour'

export {
  pickDocumentsProduction,
  pickShowcaseContract,
  TOUR_STEPS,
  tourStep,
  type TourPlace,
  type TourStep,
} from '../../shared/tour'

const STATE_KEY = 'guest-demo-tour'

/** The saved tour, or null when this tab has never seen it. */
export function loadTourState(): TourState | null {
  try {
    const raw = sessionStorage.getItem(STATE_KEY)
    return raw === null ? null : parseTourState(raw)
  } catch {
    return null
  }
}

export function saveTourState(state: TourState | null) {
  try {
    if (state === null) sessionStorage.removeItem(STATE_KEY)
    else sessionStorage.setItem(STATE_KEY, JSON.stringify(state))
  } catch {
    // Private mode or storage off: the tour just starts over after a reload.
  }
}

// ---------------------------------------------------------------------------
// The live tour state, shared by the panel and the buttons that start it.
// ---------------------------------------------------------------------------

let current: TourState | null = loadTourState()
const listeners = new Set<() => void>()

function setTour(next: TourState | null) {
  current = next
  saveTourState(next)
  for (const listener of listeners) listener()
}

export function subscribeTour(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getTour(): TourState | null {
  return current
}

export function startTour(step = 0) {
  setTour({ open: true, step: clampStep(step) })
}

export function goToTourStep(step: number) {
  setTour({ open: true, step: clampStep(step) })
}

/** Closes the panel. The tab remembers it saw the tour, so it doesn't open again by itself. */
export function closeTour() {
  setTour({ open: false, step: current?.step ?? 0 })
}

/** Forgets the tour, so the next guest session in this tab starts it again. */
export function resetTour() {
  setTour(null)
}
