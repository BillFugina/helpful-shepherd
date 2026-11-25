import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '../../server/routers/index.js'

/** What each API call returns, for typing components that take part of a response. */
export type Outputs = inferRouterOutputs<AppRouter>
