import { requireMcpAuth } from '@better-auth/mcp'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { eq } from 'drizzle-orm'
import { APP_NAME, auth, connectorResource } from './auth.js'
import { isConnected } from './connector/connections.js'
import { CONNECTOR_TOOLS, runConnectorTool, type ConnectorToolName, type ToolEnv } from './connector/tools.js'
import { lazyDb } from './db/client.js'
import { user as userTable } from './db/schema.js'
import { appOrigin } from './env.js'
import type { SessionUser } from './trpc.js'

/**
 * The Claude connector's MCP endpoint (/api/mcp). Claude signs in through the
 * app's own OAuth server (Better Auth), so every call acts as one app user,
 * with their role's view of the data and nothing more.
 */

const INSTRUCTIONS = `This connector reads the ${APP_NAME} company management app for the signed-in staff member.
- It shows only what their role in the app can see. Dates of birth, TSA and frequent flyer numbers, tax and bank documents, and housing addresses and door codes are never available here, even if asked.
- It cannot change or send anything. The one exception is draft_engagement_from_email, which saves a draft that a Company Manager must review and save in the app before anything reaches the roster.
- Every call is recorded in the app's audit log.
- Dates are theatre-local (Raleigh, America/New_York). Money is in US cents unless a field name says dollars.`

interface ConnectorAuth {
  env: ToolEnv
}

function buildServer(env: ToolEnv): McpServer {
  const server = new McpServer(
    { name: 'theatre-raleigh', title: APP_NAME, version: '1.0.0' },
    { instructions: INSTRUCTIONS },
  )
  for (const [name, def] of Object.entries(CONNECTOR_TOOLS)) {
    server.registerTool(
      name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.input,
        annotations: {
          title: def.title,
          readOnlyHint: def.readOnly,
          destructiveHint: false,
          idempotentHint: def.readOnly,
          openWorldHint: false,
        },
      },
      (args: unknown) => runConnectorTool(env, name as ConnectorToolName, args),
    )
  }
  return server
}

let handler: ReturnType<typeof createMcpHandler> | null = null
function mcpHandler() {
  handler ??= createMcpHandler(
    (ctx) => {
      const extra = ctx.authInfo?.extra as ConnectorAuth | undefined
      if (!extra) throw new Error('MCP request reached the server without a verified user.')
      return buildServer(extra.env)
    },
    {
      responseMode: 'json',
      onerror: (error) => console.error('[mcp]', error),
    },
  )
  return handler
}

export function protectedResourceMetadataUrl(origin = appOrigin()): string {
  return `${origin}/.well-known/oauth-protected-resource/api/mcp`
}

/** A 401 that sends Claude back through sign-in (RFC 6750 / RFC 9728). */
function signInAgain(description: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: description }, id: null }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer resource_metadata="${protectedResourceMetadataUrl()}", error="invalid_token", error_description="${description}"`,
    },
  })
}

async function loadUser(userId: string): Promise<SessionUser | null> {
  const [row] = await lazyDb
    .select({
      id: userTable.id,
      email: userTable.email,
      name: userTable.name,
      twoFactorEnabled: userTable.twoFactorEnabled,
    })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1)
  if (!row) return null
  return { id: row.id, email: row.email, name: row.name, twoFactorEnabled: row.twoFactorEnabled === true }
}

export async function handleMcp(request: Request): Promise<Response> {
  try {
    const protect = requireMcpAuth(
      auth(),
      async (req, claims) => {
        const userId = typeof claims.sub === 'string' ? claims.sub : null
        const clientId = typeof claims.azp === 'string' ? claims.azp : null
        if (!userId || !clientId) return signInAgain('The access token is missing its user or app.')
        const user = await loadUser(userId)
        if (!user) return signInAgain('That account no longer exists.')
        // Disconnecting in the app removes the consent; tokens stop working at once.
        if (!(await isConnected(lazyDb, userId, clientId))) {
          return signInAgain('This app was disconnected. Connect it again to continue.')
        }
        if (!user.twoFactorEnabled) return signInAgain('Two-factor sign-in is off for this account.')
        const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ') : []
        const token = req.headers.get('authorization')?.replace(/^(Bearer|DPoP)\s+/i, '') ?? ''
        const extra: ConnectorAuth = { env: { db: lazyDb, user, clientId } }
        return mcpHandler().fetch(req, {
          authInfo: { token, clientId, scopes, extra: extra as unknown as Record<string, unknown> },
        })
      },
      { resource: connectorResource() },
    )
    return await protect(request)
  } catch (error) {
    console.error('[mcp] request failed:', error)
    return Response.json(
      {
        jsonrpc: '2.0',
        error: { code: -32603, message: 'The connector is not working on the server right now.' },
        id: null,
      },
      { status: 500 },
    )
  }
}
