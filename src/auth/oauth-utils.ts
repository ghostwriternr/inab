import { z } from 'zod'
import type { AuthRequest, ClientInfo } from '@cloudflare/workers-oauth-provider'

const APPROVED_CLIENTS_COOKIE = '__Host-MCP_APPROVED_CLIENTS'
const CSRF_COOKIE = '__Host-CSRF_TOKEN'
const STATE_COOKIE = '__Host-CONSENTED_STATE'
const ONE_YEAR_IN_SECONDS = 31536000

// --- Crypto helpers ---

export class OAuthError extends Error {
  constructor(
    public code: string,
    public description: string,
    public statusCode = 400
  ) {
    super(description)
    this.name = 'OAuthError'
  }
  toHtmlResponse(): Response {
    return renderErrorPage(this.code, this.description, '', this.statusCode)
  }
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign', 'verify']
  )
}

async function signData(key: CryptoKey, data: string): Promise<string> {
  const buf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function verifySignature(key: CryptoKey, sigHex: string, data: string): Promise<boolean> {
  try {
    const sigBytes = new Uint8Array(sigHex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)))
    return await crypto.subtle.verify('HMAC', key, sigBytes.buffer, new TextEncoder().encode(data))
  } catch {
    return false
  }
}

// --- Approved clients cookie ---

async function getApprovedClients(cookieHeader: string | null, secret: string): Promise<string[]> {
  if (!cookieHeader) return []
  const cookie = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${APPROVED_CLIENTS_COOKIE}=`))
  if (!cookie) return []
  const val = cookie.substring(APPROVED_CLIENTS_COOKIE.length + 1)
  const dotIdx = val.indexOf('.')
  if (dotIdx === -1) return []
  const sigHex = val.substring(0, dotIdx)
  const b64 = val.substring(dotIdx + 1)
  if (!sigHex || !b64) return []
  const payload = atob(b64)
  const key = await importKey(secret)
  if (!(await verifySignature(key, sigHex, payload))) return []
  try {
    const arr = JSON.parse(payload)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

export async function clientIdAlreadyApproved(
  request: Request,
  clientId: string,
  secret: string
): Promise<boolean> {
  const clients = await getApprovedClients(request.headers.get('Cookie'), secret)
  return clients.includes(clientId)
}

// --- CSRF ---

export function generateCSRFProtection(): { token: string; setCookie: string } {
  const token = crypto.randomUUID()
  return {
    token,
    setCookie: `${CSRF_COOKIE}=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`
  }
}

// --- OAuth state (KV + session cookie) ---

export async function createOAuthState(
  oauthReqInfo: AuthRequest,
  kv: KVNamespace,
  codeVerifier: string
): Promise<string> {
  const stateToken = crypto.randomUUID()
  await kv.put(`oauth:state:${stateToken}`, JSON.stringify({ oauthReqInfo, codeVerifier }), {
    expirationTtl: 600
  })
  return stateToken
}

export async function bindStateToSession(stateToken: string): Promise<{ setCookie: string }> {
  const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stateToken))
  const hashHex = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return {
    setCookie: `${STATE_COOKIE}=${hashHex}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`
  }
}

const StoredStateSchema = z.object({
  oauthReqInfo: z
    .object({
      clientId: z.string(),
      scope: z.array(z.string()).optional(),
      state: z.string().optional(),
      redirectUri: z.string().optional()
    })
    .passthrough(),
  codeVerifier: z.string().min(1)
})

/**
 * Validate state returned from YNAB OAuth callback.
 * YNAB returns the raw stateToken in the `state` query param (not base64-encoded JSON).
 */
export async function validateOAuthState(
  request: Request,
  kv: KVNamespace
): Promise<{ oauthReqInfo: AuthRequest; codeVerifier: string; clearCookie: string }> {
  const stateToken = new URL(request.url).searchParams.get('state')
  if (!stateToken) throw new OAuthError('invalid_request', 'Missing state parameter')

  const stored = await kv.get(`oauth:state:${stateToken}`)
  if (!stored) throw new OAuthError('invalid_request', 'Invalid or expired state')

  // Verify session cookie binding
  const cookies = (request.headers.get('Cookie') || '').split(';').map((c) => c.trim())
  const stateCookie = cookies.find((c) => c.startsWith(`${STATE_COOKIE}=`))
  const stateHash = stateCookie ? stateCookie.substring(STATE_COOKIE.length + 1) : null
  if (!stateHash) throw new OAuthError('invalid_request', 'Missing session binding')

  const expectedHash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stateToken)))
  )
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  if (stateHash !== expectedHash) throw new OAuthError('invalid_request', 'State mismatch')

  const parsed = StoredStateSchema.safeParse(JSON.parse(stored))
  if (!parsed.success) throw new OAuthError('server_error', 'Invalid stored state')

  await kv.delete(`oauth:state:${stateToken}`)

  return {
    oauthReqInfo: parsed.data.oauthReqInfo as unknown as AuthRequest,
    codeVerifier: parsed.data.codeVerifier,
    clearCookie: `${STATE_COOKIE}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`
  }
}

// --- Consent form parsing ---

export async function parseRedirectApproval(
  request: Request,
  cookieSecret: string
): Promise<{ state: Record<string, unknown>; headers: Record<string, string> }> {
  const formData = await request.formData()

  // CSRF check
  const csrfFromForm = formData.get('csrf_token') as string
  const cookieHeader = request.headers.get('Cookie') || ''
  const csrfCookie = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${CSRF_COOKIE}=`))
  const csrfFromCookie = csrfCookie ? csrfCookie.substring(CSRF_COOKIE.length + 1) : null
  if (!csrfFromForm || csrfFromForm !== csrfFromCookie)
    throw new OAuthError('access_denied', 'CSRF mismatch', 403)

  const encodedState = formData.get('state') as string
  if (!encodedState) throw new OAuthError('invalid_request', 'Missing state')
  const state = JSON.parse(atob(encodedState)) as Record<string, unknown>

  // Update approved clients cookie
  const existing = await getApprovedClients(request.headers.get('Cookie'), cookieSecret)
  const oauthReqInfo = state.oauthReqInfo as Record<string, unknown> | undefined
  const clientId = oauthReqInfo?.clientId as string | undefined
  const updated = [...new Set([...existing, clientId].filter(Boolean))]
  const payload = JSON.stringify(updated)
  const key = await importKey(cookieSecret)
  const sig = await signData(key, payload)

  return {
    state,
    headers: {
      'Set-Cookie': `${APPROVED_CLIENTS_COOKIE}=${sig}.${btoa(payload)}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${ONE_YEAR_IN_SECONDS}`
    }
  }
}

// --- Rendering ---

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function renderErrorPage(
  title: string,
  message: string,
  details: string,
  status = 400
): Response {
  return new Response(
    `<!DOCTYPE html><html><head><title>${esc(title)}</title></head><body><h1>${esc(title)}</h1><p>${esc(message)}</p>${details ? `<pre>${esc(details)}</pre>` : ''}</body></html>`,
    {
      status,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY' }
    }
  )
}

export function renderApprovalDialog(
  _request: Request,
  options: {
    client: ClientInfo | null
    server: { name: string; description?: string }
    state: Record<string, unknown>
    csrfToken: string
    setCookie: string
  }
): Response {
  const { client, server, state, csrfToken, setCookie } = options
  const clientName = client?.clientName ? esc(client.clientName) : 'Unknown MCP Client'
  const encodedState = btoa(JSON.stringify(state))

  const html = `<!DOCTYPE html><html><head><title>Authorize | ${esc(server.name)}</title>
<style>body{font-family:system-ui;max-width:480px;margin:4rem auto;padding:1rem}
.card{border:1px solid #ddd;border-radius:8px;padding:2rem;text-align:center}
button{padding:0.75rem 2rem;border-radius:4px;border:none;cursor:pointer;font-size:1rem;margin:0.5rem}
.approve{background:#2563eb;color:white} .deny{background:#e5e7eb;color:#333}</style></head>
<body><div class="card">
<h2>${esc(server.name)}</h2>
<p>${server.description ? esc(server.description) : ''}</p>
<p><strong>${clientName}</strong> wants to access your YNAB data.</p>
<form method="POST" action="/authorize">
<input type="hidden" name="csrf_token" value="${esc(csrfToken)}">
<input type="hidden" name="state" value="${esc(encodedState)}">
<button type="submit" class="approve">Approve</button>
</form>
<p style="margin-top:1rem"><a href="javascript:window.close()">Deny</a></p>
</div></body></html>`

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': setCookie,
      'X-Frame-Options': 'DENY'
    }
  })
}
