import { handleInngest } from '../server/inngest/handler.js'

// Inngest syncs with PUT and runs functions with POST; GET reports the app's status.
export const GET = handleInngest
export const POST = handleInngest
export const PUT = handleInngest
