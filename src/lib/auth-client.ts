import { createAuthClient } from 'better-auth/react'
import { twoFactorClient } from 'better-auth/client/plugins'
import { oauthProviderClient } from '@better-auth/oauth-provider/client'

// Same origin as the app: /api/auth is proxied locally and rewritten on Vercel.
// The sign-in page handles the second-factor step itself, so no redirect here.
export const authClient = createAuthClient({
  basePath: '/api/auth',
  // oauthProviderClient carries an app's signed connect request through sign-in
  // and the Connect page (see ConnectPage).
  plugins: [twoFactorClient(), oauthProviderClient()],
})
