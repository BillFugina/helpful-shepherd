import { handleAuth } from '../server/handlers.js'

// OAuth discovery (/.well-known/oauth-authorization-server/..., /.well-known/oauth-protected-resource/...).
// vercel.json rewrites /.well-known/* here; Better Auth's plugins answer them. request.url keeps the original path.
export const GET = handleAuth
