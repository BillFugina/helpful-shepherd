/** The server's machine-readable FORBIDDEN reasons (see server/trpc.ts). */
export function forbiddenReason(
  error: unknown,
): 'TWO_FACTOR_REQUIRED' | 'NO_ROLE' | 'ADMIN_ONLY' | 'DEMO_READ_ONLY' | 'DEMO_CLOSED' | null {
  const message = (error as { message?: unknown } | null)?.message
  return message === 'TWO_FACTOR_REQUIRED' ||
    message === 'NO_ROLE' ||
    message === 'ADMIN_ONLY' ||
    message === 'DEMO_READ_ONLY' ||
    message === 'DEMO_CLOSED'
    ? message
    : null
}

export function errorText(error: unknown, fallback = 'Something went wrong.'): string {
  if (forbiddenReason(error) === 'DEMO_READ_ONLY') return 'This is a read-only demo, so changes are turned off.'
  if (forbiddenReason(error) === 'DEMO_CLOSED') return 'The demo is closed right now.'
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' && message ? message : fallback
}
