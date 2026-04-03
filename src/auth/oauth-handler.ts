import { env as cloudflareEnv } from 'cloudflare:workers'
import { Hono } from 'hono'

import {
  generatePKCECodes,
  getYnabAuthorizationURL,
  exchangeYnabCode,
  refreshYnabToken,
  resolveYnabUserId,
} from './ynab-auth'
import type { YnabOAuthProps } from './ynab-auth'
import {
  clientIdAlreadyApproved,
  createOAuthState,
  bindStateToSession,
  validateOAuthState,
  generateCSRFProtection,
  parseRedirectApproval,
  renderApprovalDialog,
  renderErrorPage,
  OAuthError,
} from './oauth-utils'

import type {
  AuthRequest,
  OAuthHelpers,
  TokenExchangeCallbackOptions,
  TokenExchangeCallbackResult,
} from '@cloudflare/workers-oauth-provider'

interface AuthEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers
  YNAB_CLIENT_ID: string
  YNAB_CLIENT_SECRET: string
  COOKIE_ENCRYPTION_KEY: string
}

const env = cloudflareEnv as AuthEnv

/** Must match the accessTokenTTL in the OAuthProvider config */
const MCP_ACCESS_TOKEN_TTL = 3600
/** Buffer to avoid edge-case expiry races */
const SKEW_BUFFER_MS = 5 * 60 * 1000

/**
 * Called by the OAuth provider when an MCP client refreshes its token.
 * If the YNAB access token will expire before the next MCP token cycle,
 * refresh it proactively.
 */
export async function handleTokenExchangeCallback(
  options: TokenExchangeCallbackOptions,
): Promise<TokenExchangeCallbackResult | undefined> {
  if (options.grantType !== 'refresh_token') {
    return undefined
  }

  const props = options.props as YnabOAuthProps | undefined
  if (!props?.ynabRefreshToken) {
    return undefined
  }

  const needsRefresh =
    Date.now() + MCP_ACCESS_TOKEN_TTL * 1000 + SKEW_BUFFER_MS >=
    props.ynabTokenExpiry

  if (!needsRefresh) {
    return undefined
  }

  const tokenResponse = await refreshYnabToken({
    refreshToken: props.ynabRefreshToken,
    clientId: env.YNAB_CLIENT_ID,
    clientSecret: env.YNAB_CLIENT_SECRET,
    oauthBase: env.YNAB_OAUTH_BASE,
  })

  const newProps: YnabOAuthProps = {
    ynabAccessToken: tokenResponse.access_token,
    ynabRefreshToken: tokenResponse.refresh_token,
    ynabTokenExpiry: Date.now() + tokenResponse.expires_in * 1000,
  }

  return {
    newProps,
    accessTokenTTL: MCP_ACCESS_TOKEN_TTL,
  }
}

/**
 * Create Hono routes for the MCP OAuth authorization flow.
 */
export function createAuthHandlers() {
  const app = new Hono()

  // GET /authorize — Show consent page or skip if client previously approved
  app.get('/authorize', async (c) => {
    try {
      const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw)

      if (!oauthReqInfo.clientId) {
        return new OAuthError(
          'invalid_request',
          'Missing client_id',
        ).toHtmlResponse()
      }

      // Check if client was previously approved — skip consent if so
      if (
        await clientIdAlreadyApproved(
          c.req.raw,
          oauthReqInfo.clientId,
          env.COOKIE_ENCRYPTION_KEY,
        )
      ) {
        const { codeChallenge, codeVerifier } = await generatePKCECodes()
        const stateToken = await createOAuthState(
          oauthReqInfo,
          env.OAUTH_KV,
          codeVerifier,
        )
        const { setCookie: sessionCookie } =
          await bindStateToSession(stateToken)

        const ynabAuthUrl = getYnabAuthorizationURL({
          clientId: env.YNAB_CLIENT_ID,
          redirectUri: new URL('/ynab/callback', c.req.url).href,
          codeChallenge,
          state: stateToken,
          oauthBase: env.YNAB_OAUTH_BASE,
        })

        return new Response(null, {
          status: 302,
          headers: {
            Location: ynabAuthUrl,
            'Set-Cookie': sessionCookie,
          },
        })
      }

      // Client not approved — show consent dialog
      const { token: csrfToken, setCookie: csrfCookie } =
        generateCSRFProtection()

      return renderApprovalDialog(c.req.raw, {
        client: await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId),
        server: {
          name: 'YNAB MCP',
          description: 'Access your YNAB budget data through the Model Context Protocol.',
        },
        state: { oauthReqInfo },
        csrfToken,
        setCookie: csrfCookie,
      })
    } catch (e) {
      if (e instanceof OAuthError) return e.toHtmlResponse()
      const errorId = crypto.randomUUID()
      console.error(`Authorize error [${errorId}]:`, e)
      return renderErrorPage(
        'Server Error',
        'An unexpected error occurred. Please try again.',
        `Error ID: ${errorId}`,
        500,
      )
    }
  })

  // POST /authorize — Handle consent form submission
  app.post('/authorize', async (c) => {
    try {
      const { state, headers } = await parseRedirectApproval(
        c.req.raw,
        env.COOKIE_ENCRYPTION_KEY,
      )

      if (!state.oauthReqInfo) {
        return new OAuthError(
          'invalid_request',
          'Missing OAuth request info',
        ).toHtmlResponse()
      }

      const oauthReqInfo = state.oauthReqInfo as AuthRequest

      const { codeChallenge, codeVerifier } = await generatePKCECodes()
      const stateToken = await createOAuthState(
        oauthReqInfo,
        env.OAUTH_KV,
        codeVerifier,
      )
      const { setCookie: sessionCookie } = await bindStateToSession(stateToken)

      const ynabAuthUrl = getYnabAuthorizationURL({
        clientId: env.YNAB_CLIENT_ID,
        redirectUri: new URL('/ynab/callback', c.req.url).href,
        codeChallenge,
        state: stateToken,
        oauthBase: env.YNAB_OAUTH_BASE,
      })

      const responseHeaders = new Headers()
      responseHeaders.set('Location', ynabAuthUrl)
      if (headers['Set-Cookie']) {
        responseHeaders.append('Set-Cookie', headers['Set-Cookie'])
      }
      responseHeaders.append('Set-Cookie', sessionCookie)

      return new Response(null, {
        status: 302,
        headers: responseHeaders,
      })
    } catch (e) {
      if (e instanceof OAuthError) return e.toHtmlResponse()
      const errorId = crypto.randomUUID()
      console.error(`Authorize POST error [${errorId}]:`, e)
      return renderErrorPage(
        'Server Error',
        'An unexpected error occurred. Please try again.',
        `Error ID: ${errorId}`,
        500,
      )
    }
  })

  // GET /ynab/callback — Handle YNAB OAuth redirect
  app.get('/ynab/callback', async (c) => {
    try {
      // Handle error callbacks from YNAB
      const error = c.req.query('error')
      if (error) {
        const errorDescription =
          c.req.query('error_description') || 'Authorization was denied'
        return renderErrorPage(
          'Authorization Failed',
          errorDescription,
          `Error: ${error}`,
          400,
        )
      }

      const code = c.req.query('code')
      if (!code) {
        return new OAuthError(
          'invalid_request',
          'Missing code',
        ).toHtmlResponse()
      }

      // Validate state using dual validation (KV + session cookie)
      const { oauthReqInfo, codeVerifier, clearCookie } =
        await validateOAuthState(c.req.raw, env.OAUTH_KV)

      if (!oauthReqInfo.clientId) {
        return new OAuthError(
          'invalid_request',
          'Invalid OAuth request info',
        ).toHtmlResponse()
      }

      // Exchange code for tokens and ensure client is registered
      const [tokenResponse] = await Promise.all([
        exchangeYnabCode({
          code,
          redirectUri: new URL('/ynab/callback', c.req.url).href,
          codeVerifier,
          clientId: env.YNAB_CLIENT_ID,
          clientSecret: env.YNAB_CLIENT_SECRET,
          oauthBase: env.YNAB_OAUTH_BASE,
        }),
        env.OAUTH_PROVIDER.createClient({
          clientId: oauthReqInfo.clientId,
          tokenEndpointAuthMethod: 'none',
        }),
      ])

      // Resolve YNAB user ID
      const userId = await resolveYnabUserId(
        tokenResponse.access_token,
        env.YNAB_API_BASE,
      )

      const props: YnabOAuthProps = {
        ynabAccessToken: tokenResponse.access_token,
        ynabRefreshToken: tokenResponse.refresh_token,
        ynabTokenExpiry: Date.now() + tokenResponse.expires_in * 1000,
      }

      // Complete authorization
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthReqInfo,
        userId,
        metadata: { label: `YNAB user ${userId}` },
        scope: oauthReqInfo.scope,
        props,
      })

      return new Response(null, {
        status: 302,
        headers: {
          Location: redirectTo,
          'Set-Cookie': clearCookie,
        },
      })
    } catch (e) {
      if (e instanceof OAuthError) return e.toHtmlResponse()
      const errorId = crypto.randomUUID()
      console.error(`Callback error [${errorId}]:`, e)
      return renderErrorPage(
        'Server Error',
        'An unexpected error occurred during authorization.',
        `Error ID: ${errorId}`,
        500,
      )
    }
  })

  return app
}
