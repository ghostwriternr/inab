import OAuthProvider from '@cloudflare/workers-oauth-provider'
import { Hono } from 'hono'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createServer } from './server'
import {
  createAuthHandlers,
  handleTokenExchangeCallback,
} from './auth/oauth-handler'
import type { YnabOAuthProps } from './auth/ynab-auth'

import specData from '../spec/ynab-spec.json'

export { GlobalOutbound } from './global-outbound'

const specJson = JSON.stringify(specData)

type McpContext = {
  Bindings: Env
}

/**
 * Default handler: health check + OAuth authorization routes
 */
function createDefaultHandler() {
  const app = new Hono()

  app.get('/', (c) => c.text('inab'))
  app.route('/', createAuthHandlers())

  return app
}

/**
 * MCP API handler: origin validation + Streamable HTTP transport
 */
function createMcpHandler() {
  const app = new Hono<McpContext>()

  // Origin validation middleware
  app.use('/mcp', async (c, next) => {
    const allowedOrigins = c.env.ALLOWED_ORIGINS as string
    if (allowedOrigins) {
      const origin = c.req.header('origin')
      const allowed = allowedOrigins.split(',').map((o: string) => o.trim())
      if (origin && !allowed.includes(origin)) {
        return c.json({ error: 'Origin not allowed' }, 403)
      }
    }
    await next()
  })

  app.all('/mcp', async (c) => {
    const ctx = c.executionCtx as ExecutionContext & {
      props?: YnabOAuthProps
    }
    const props = ctx.props

    if (!props?.ynabAccessToken) {
      return c.json({ error: 'Not authenticated' }, 401)
    }

    const server = await createServer(
      c.env,
      ctx,
      props.ynabAccessToken,
      specJson,
    )

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      retryInterval: 1000,
    })

    await server.connect(transport)
    const response = await transport.handleRequest(c.req.raw)
    ctx.waitUntil(transport.close())

    return response
  })

  return app
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return new OAuthProvider({
      apiHandlers: {
        // @ts-ignore - Hono apps are compatible with ExportedHandler at runtime
        '/mcp': createMcpHandler(),
      },
      // @ts-ignore - Hono apps are compatible with ExportedHandler at runtime
      defaultHandler: createDefaultHandler(),
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register',
      tokenExchangeCallback: (options) => handleTokenExchangeCallback(options),
      resourceMetadata: {
        resource_name: 'inab',
      },
      accessTokenTTL: 3600,
      refreshTokenTTL: 2592000, // 30 days
    }).fetch(request, env, ctx)
  },
}
