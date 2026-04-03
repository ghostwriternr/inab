import { WorkerEntrypoint } from 'cloudflare:workers'

type GlobalOutboundProps = { apiToken: string }

export class GlobalOutbound extends WorkerEntrypoint<Env, GlobalOutboundProps> {
  async fetch(request: Request): Promise<Response> {
    const allowed = new URL(this.env.YNAB_API_BASE).hostname
    const requested = new URL(request.url).hostname
    if (requested !== allowed) {
      return new Response(
        `Forbidden: requests to ${requested} are not allowed. Only ${allowed} is permitted.`,
        { status: 403 }
      )
    }
    // Strip any agent-set Authorization header and inject the real token
    const headers = new Headers(request.headers)
    headers.delete('Authorization')
    headers.set('Authorization', `Bearer ${this.ctx.props.apiToken}`)

    const authedRequest = new Request(request, { headers })
    return fetch(authedRequest)
  }
}
