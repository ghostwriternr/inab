export interface YnabTokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token: string
}

export interface YnabOAuthProps {
  ynabAccessToken: string
  ynabRefreshToken: string
  ynabTokenExpiry: number
}

export async function generatePKCECodes(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  const codeVerifier = btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
  const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  return { codeVerifier, codeChallenge }
}

export function getYnabAuthorizationURL(params: {
  clientId: string
  redirectUri: string
  codeChallenge: string
  state: string
  oauthBase: string
}): string {
  const url = new URL(`${params.oauthBase}/authorize`)
  url.searchParams.set('client_id', params.clientId)
  url.searchParams.set('redirect_uri', params.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('code_challenge', params.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', params.state)
  return url.toString()
}

export async function exchangeYnabCode(params: {
  code: string
  redirectUri: string
  codeVerifier: string
  clientId: string
  clientSecret: string
  oauthBase: string
}): Promise<YnabTokenResponse> {
  const body = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
    grant_type: 'authorization_code',
    code: params.code,
    code_verifier: params.codeVerifier,
  })

  const response = await fetch(`${params.oauthBase}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`YNAB token exchange failed (${response.status}): ${text}`)
  }

  return response.json() as Promise<YnabTokenResponse>
}

export async function refreshYnabToken(params: {
  refreshToken: string
  clientId: string
  clientSecret: string
  oauthBase: string
}): Promise<YnabTokenResponse> {
  const body = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
  })

  const response = await fetch(`${params.oauthBase}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`YNAB token refresh failed (${response.status}): ${text}`)
  }

  return response.json() as Promise<YnabTokenResponse>
}

export async function resolveYnabUserId(accessToken: string, apiBase: string): Promise<string> {
  const response = await fetch(`${apiBase}/user`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    throw new Error(`Failed to resolve YNAB user: ${response.status}`)
  }
  const data = (await response.json()) as { data: { user: { id: string } } }
  return data.data.user.id
}
