import { serve } from 'inngest/edge'
import { inngest, inngestEnabled } from './client.js'
import { functions } from './functions.js'
import { reminderFunctions } from './reminders.js'

let serveInngest: ((request: Request) => Promise<Response>) | undefined

/** /api/inngest: Inngest calls this to sync the app and run its scheduled functions. */
export async function handleInngest(request: Request): Promise<Response> {
  if (!inngestEnabled()) return new Response('Not found', { status: 404 })
  serveInngest ??= serve({ client: inngest, functions: [...functions, ...reminderFunctions] })
  return serveInngest(request)
}
