import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { createSearchExecutor, createCodeExecutor } from './executor'
import type { ExecutionContextWithExports } from './executor'
import { truncateContent } from './truncate'

const YNAB_TYPES = `
/** Available in the search tool as a global */
declare const spec: {
  paths: Record<string, Record<string, { summary?: string; description?: string; operationId?: string; parameters?: unknown[]; requestBody?: unknown; responses?: unknown }>>
  components: { schemas: Record<string, unknown> }
}

/** Available in the execute tool as a global */
declare const ynab: {
  request(path: string, options?: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    query?: Record<string, string | number | boolean | undefined>
    body?: unknown
    headers?: Record<string, string>
  }): Promise<unknown>
}

/** YNAB data notes:
 * - Currency amounts are in milliunits (1000ths): $1.23 = 1230
 * - Dates are ISO 8601: "2025-12-30"
 * - Use "last-used" as plan_id to target the most recently used plan
 * - Most GET endpoints accept last_knowledge_of_server for delta responses
 * - Common patterns:
 *   GET /plans - list all plans
 *   GET /plans/{plan_id}/transactions - list transactions
 *   GET /plans/{plan_id}/accounts - list accounts
 *   GET /plans/{plan_id}/categories - list categories
 *   POST /plans/{plan_id}/transactions - create transaction(s)
 */
`

export async function createServer(
  env: Env,
  ctx: ExecutionContextWithExports,
  apiToken: string,
  specJson: string
): Promise<McpServer> {
  const server = new McpServer({ name: 'inab', version: '1.0.0' })
  const search = createSearchExecutor(env, specJson)
  const execute = createCodeExecutor(env, ctx)

  server.registerTool(
    'search',
    {
      title: 'Search YNAB API',
      description: `Search the YNAB OpenAPI spec to discover API endpoints. Write JavaScript that queries the \`spec\` global and return results.\n\n${YNAB_TYPES}`,
      inputSchema: {
        code: z
          .string()
          .describe(
            'JavaScript code. Must return a value. Has access to `spec` global.'
          ),
      },
    },
    async ({ code }) => {
      try {
        const result = await search(code)
        return {
          content: [{ type: 'text' as const, text: truncateContent(result) }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${err instanceof Error ? err.message : err}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  server.registerTool(
    'execute',
    {
      title: 'Execute YNAB API Call',
      description: `Call the YNAB API using \`ynab.request(path, options)\`. Auth is automatic.\n\n${YNAB_TYPES}`,
      inputSchema: {
        code: z
          .string()
          .describe(
            'JavaScript code. Must return a value. Has access to `ynab.request()`.'
          ),
      },
    },
    async ({ code }) => {
      try {
        const result = await execute(code, apiToken)
        return {
          content: [{ type: 'text' as const, text: truncateContent(result) }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${err instanceof Error ? err.message : err}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  return server
}
