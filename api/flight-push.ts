import { handleFlightPush } from '../server/flights/webhook.js'

// vercel.json rewrites /api/flight-push/* here; request.url keeps the original path.
export const POST = handleFlightPush
