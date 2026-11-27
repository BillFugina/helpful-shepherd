import { Inngest } from 'inngest'

/** The app as Inngest knows it. Keys come from INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY. */
export const inngest = new Inngest({ id: 'helpful-shepherd' })

/**
 * Whether /api/inngest answers at all. On Vercel it needs the signing key, so
 * requests are checked against it; without one the endpoint is a 404 and the
 * app runs exactly as before (the tracker runs when the board is opened).
 * Locally, INNGEST_DEV turns it on for the Inngest dev server. INNGEST_DEV is
 * ignored on Vercel, because dev mode skips the signature check.
 */
export function inngestEnabled(e: NodeJS.ProcessEnv = process.env): boolean {
  if (e.INNGEST_SIGNING_KEY) return true
  const dev = e.INNGEST_DEV
  return !e.VERCEL && !!dev && dev !== '0' && dev !== 'false'
}
