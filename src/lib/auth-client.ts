import { createAuthClient } from 'better-auth/react'
import { twoFactorClient } from 'better-auth/client/plugins'

// Same origin as the app: /api/auth is proxied locally and rewritten on Vercel.
// The sign-in page handles the second-factor step itself, so no redirect here.
export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [twoFactorClient()],
})
