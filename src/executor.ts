interface ExecutorEntrypoint {
  evaluate(): Promise<{ result: unknown; err?: string; stack?: string }>
}

export function buildSearchWorkerCode(specJson: string, agentCode: string): string {
  return `
import { WorkerEntrypoint } from "cloudflare:workers";

const spec = ${specJson};

export default class SearchExecutor extends WorkerEntrypoint {
  async evaluate() {
    try {
      const result = await (async () => { ${agentCode} })();
      return { result, err: undefined };
    } catch (err) {
      return { result: undefined, err: err.message, stack: err.stack };
    }
  }
}
`
}

export function buildExecuteWorkerCode(apiBase: string, agentCode: string): string {
  return `
import { WorkerEntrypoint } from "cloudflare:workers";

const apiBase = ${JSON.stringify(apiBase)};

export default class ExecuteExecutor extends WorkerEntrypoint {
  async evaluate() {
    const r2 = this.env.R2;
    const ynab = {
      async request(path, options = {}) {
        const { method = 'GET', query, body, headers: extraHeaders = {} } = options;

        const url = new URL(apiBase + path);
        if (query) {
          for (const [key, value] of Object.entries(query)) {
            if (value !== undefined && value !== null) {
              url.searchParams.set(key, String(value));
            }
          }
        }

        const headers = { ...extraHeaders };
        const fetchOptions = { method, headers };

        if (body !== undefined) {
          headers['Content-Type'] = 'application/json';
          fetchOptions.body = JSON.stringify(body);
        }

        const response = await fetch(url.toString(), fetchOptions);

        if (response.status === 429) {
          throw new Error('YNAB rate limit exceeded (200 requests/hour). Try again later.');
        }

        const text = await response.text();
        let parsed;
        try { parsed = JSON.parse(text); } catch {
          if (!response.ok) throw new Error('YNAB API error ' + response.status + ': ' + text);
          return text;
        }

        if (!response.ok) {
          const detail = parsed?.error?.detail || parsed?.error?.name || 'Unknown error';
          const id = parsed?.error?.id || response.status;
          throw new Error('YNAB API error ' + id + ': ' + detail);
        }

        return parsed;
      }
    };

    try {
      const result = await (async () => { ${agentCode} })();
      return { result, err: undefined };
    } catch (err) {
      return { result: undefined, err: err.message, stack: err.stack };
    }
  }
}
`
}

export function createSearchExecutor(env: Env, specJson: string) {
  return async (code: string): Promise<unknown> => {
    const workerId = `ynab-search-${crypto.randomUUID()}`

    const worker = env.LOADER.get(workerId, () => ({
      compatibilityDate: '2026-03-23',
      globalOutbound: null,
      mainModule: 'worker.js',
      modules: { 'worker.js': buildSearchWorkerCode(specJson, code) }
    }))

    const entrypoint = worker.getEntrypoint() as unknown as ExecutorEntrypoint
    const response = await entrypoint.evaluate()

    if (response.err) throw new Error(response.err)
    return response.result
  }
}

export function createCodeExecutor(env: Env, ctx: ExecutionContext) {
  return async (code: string, apiToken: string): Promise<unknown> => {
    const workerId = `ynab-exec-${crypto.randomUUID()}`

    const worker = env.LOADER.get(workerId, () => ({
      compatibilityDate: '2026-03-23',
      globalOutbound: ctx.exports.GlobalOutbound({ props: { apiToken } }),
      env: { R2: ctx.exports.R2Proxy({}) },
      mainModule: 'worker.js',
      modules: { 'worker.js': buildExecuteWorkerCode(env.YNAB_API_BASE, code) }
    }))

    const entrypoint = worker.getEntrypoint() as unknown as ExecutorEntrypoint
    const response = await entrypoint.evaluate()

    if (response.err) throw new Error(response.err)
    return response.result
  }
}
