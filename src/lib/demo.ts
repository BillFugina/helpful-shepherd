import { authClient } from './auth-client'
import { resetTour } from './tour'

/**
 * "Try the demo": asks the server for a guest session (no password, read-only,
 * two hours). Returns an error message to show, or null when it worked.
 */
export async function startGuestDemo(): Promise<string | null> {
  const res = await authClient.$fetch('/demo/guest', { method: 'POST' })
  if (!res.error) {
    // A new guest session gets the guided tour again.
    resetTour()
    return null
  }
  if (res.error.status === 429) return 'Too many tries. Wait a minute and try again.'
  return res.error.message || 'The demo didn’t start. Try again in a moment.'
}

/** Where a guest's own demo clock lives: this browser tab only. */
const CLOCK_KEY = 'guest-demo-clock-offset'

export function loadGuestClock(): number | null {
  try {
    const raw = sessionStorage.getItem(CLOCK_KEY)
    const n = raw === null ? NaN : Number(raw)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

export function saveGuestClock(offsetMs: number | null) {
  try {
    if (offsetMs === null) sessionStorage.removeItem(CLOCK_KEY)
    else sessionStorage.setItem(CLOCK_KEY, String(Math.round(offsetMs)))
  } catch {
    // Private mode or storage off: the clock just won't survive a reload.
  }
}
