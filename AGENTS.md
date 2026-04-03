# AGENTS.md

## Project overview

`inab` is a token-efficient Model Context Protocol (MCP) server that exposes the full YNAB (You Need A Budget) API (~45 endpoints) using the **Code Mode** pattern. Instead of registering individual MCP tools per endpoint, it uses just two tools (`search` and `execute`) that let agents write JavaScript to query the OpenAPI spec and call APIs.

Deployed to Cloudflare Workers.

## MCP specification compliance

When modifying MCP or OAuth functionality, **always check the latest published MCP specification**:

- **Specification:** https://modelcontextprotocol.io/specification/2025-11-25
- **Authorization section:** https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization

## Repository structure

```
inab/
├── src/
│   ├── index.ts                   # Worker entry point, Hono routing, OAuthProvider setup
│   ├── server.ts                  # MCP server setup & tool registration (search + execute)
│   ├── executor.ts                # Code executor (Worker Loader API, search & execute isolates)
│   ├── global-outbound.ts         # GlobalOutbound WorkerEntrypoint (restricts fetch to YNAB API)
│   ├── spec-processor.ts          # OpenAPI spec $ref resolution & x- extension stripping
│   ├── truncate.ts                # Response truncation (~6K token limit)
│   ├── auth/
│   │   ├── oauth-handler.ts       # OAuth authorization flow (consent, callback, token refresh)
│   │   ├── oauth-utils.ts         # CSRF, state management, cookie helpers, approval dialog
│   │   └── ynab-auth.ts           # YNAB OAuth (PKCE, token exchange, refresh, user resolution)
│   └── tests/
│       ├── executor.test.ts       # Worker code generation tests
│       ├── spec-processor.test.ts # $ref resolution & spec processing tests
│       └── truncate.test.ts       # Truncation behavior tests
├── scripts/
│   └── build-spec.ts              # Fetch YNAB OpenAPI spec (YAML), process, write to spec/
├── spec/
│   └── ynab-spec.json             # Processed OpenAPI spec (gitignored, built via build:spec)
├── wrangler.jsonc                 # Workers config (dev/staging/production)
├── vitest.config.mts              # Vitest config with @cloudflare/vitest-pool-workers
├── tsconfig.json                  # TypeScript strict config
├── .oxfmtrc.json                  # oxfmt formatter config
├── worker-configuration.d.ts      # Generated worker types (gitignored)
└── package.json
```

## Setup

```bash
npm install        # Install dependencies
npm run build:spec # Fetch & process the YNAB OpenAPI spec
```

Node 22+ required.

### Secrets

Set these via `npx wrangler secret put <NAME>`:

| Secret                 | Purpose                                          |
| ---------------------- | ------------------------------------------------ |
| `YNAB_CLIENT_ID`       | YNAB OAuth application client ID                 |
| `YNAB_CLIENT_SECRET`   | YNAB OAuth application client secret             |
| `COOKIE_ENCRYPTION_KEY` | HMAC key for signing approved-client cookies     |

### Bindings

| Binding      | Type           | Purpose                       |
| ------------ | -------------- | ----------------------------- |
| `OAUTH_KV`   | KV Namespace   | OAuth state storage           |
| `LOADER`      | Worker Loader  | Dynamic worker instantiation  |

## Commands

| Command                | What it does                                  |
| ---------------------- | --------------------------------------------- |
| `npm run dev`          | Start local dev server (wrangler dev)         |
| `npm run deploy`       | Deploy to staging                             |
| `npm run deploy:prod`  | Deploy to production                          |
| `npm run types`        | Generate worker type definitions              |
| `npm run typecheck`    | TypeScript type checking (no emit)            |
| `npm run lint`         | Lint with oxlint                              |
| `npm run format`       | Format with oxfmt                             |
| `npm run format:check` | Check formatting without modifying            |
| `npm run test`         | Run vitest test suite                         |
| `npm run test:watch`   | Run vitest in watch mode                      |
| `npm run check`        | Run all checks (format, lint, typecheck, test)|
| `npm run build:spec`   | Fetch & process YNAB OpenAPI spec to spec/    |

## Code standards

### TypeScript

- Strict mode enabled
- Target: ES2022, Module: ESNext
- Runtime validation with Zod for OAuth state and external data

### Formatting & linting

- **oxfmt** for formatting: single quotes, no semicolons, no trailing commas
- **oxlint** for linting
- Run `npm run format` before committing

### Naming conventions

- `PascalCase` for classes, interfaces, types, enums
- `camelCase` for functions, methods, variables
- `SCREAMING_SNAKE_CASE` for constants

## Architecture

### Two-tool Code Mode pattern

Two tools handle all ~45 YNAB API endpoints:

1. **`search` tool** -- Agents write JavaScript to query the pre-resolved OpenAPI spec (all `$ref`s inlined, `x-` extensions stripped). Runs in an isolated worker with **no network access** (`globalOutbound: null`).
2. **`execute` tool** -- Agents write JavaScript using `ynab.request(path, options)` to call discovered endpoints. Runs in an isolated worker with outbound restricted to `api.ynab.com` only.

### Worker Loader API

Code execution uses Cloudflare's Worker Loader API (`env.LOADER`) to dynamically create isolated worker instances per invocation. Each gets a unique ID (`ynab-search-<uuid>` or `ynab-exec-<uuid>`). The API token is injected by `GlobalOutbound` and never enters user code.

### GlobalOutbound

`GlobalOutbound` (`src/global-outbound.ts`) is a `WorkerEntrypoint` that acts as a fetch proxy for execute isolates:

- Restricts all outbound requests to the `YNAB_API_BASE` hostname (`api.ynab.com`)
- Strips any `Authorization` header set by agent code
- Injects the real YNAB bearer token from `ctx.props.apiToken`

### Authentication

OAuth delegation to YNAB via `@cloudflare/workers-oauth-provider`:

- MCP clients authenticate with this server via standard OAuth
- This server delegates to YNAB OAuth with PKCE (RFC 7636)
- YNAB tokens stored as OAuth props (`YnabOAuthProps`: access token, refresh token, expiry)
- Proactive token refresh on MCP token exchange when YNAB token nears expiry
- Client approval persisted via HMAC-signed cookies to skip consent on reconnect
- OAuth state validated via dual mechanism: KV storage + session cookie binding (SHA-256 hash)
- CSRF protection on consent form via `__Host-CSRF_TOKEN` cookie

### OpenAPI spec processing

- Fetched from `https://api.ynab.com/papi/open_api_spec.yaml` via `npm run build:spec`
- Parsed from YAML, all `$ref` references resolved inline
- Vendor extensions (`x-*` fields) stripped to reduce size
- Output: `spec/ynab-spec.json` containing only `paths` and `components.schemas`
- Bundled into the worker at build time via JSON import

### Response truncation

Responses capped at ~6,000 tokens (~24KB). Truncation notice includes original size and suggests filtering strategies (date, account, category, `server_knowledge` for delta requests).

### YNAB API notes

- Currency amounts are in **milliunits** (1000ths): `$1.23 = 1230`
- Dates are ISO 8601: `"2025-12-30"`
- Use `"last-used"` as `plan_id` to target the most recently used budget
- Most GET endpoints accept `last_knowledge_of_server` for delta responses
- Rate limit: 200 requests/hour (429 errors handled with descriptive message)

## Security considerations

- YNAB API tokens never enter user code isolates -- injected by `GlobalOutbound` via worker props
- `GlobalOutbound` restricts execute tool to `api.ynab.com` only, blocks all other hosts
- Search tool runs with `globalOutbound: null` (no network access)
- OAuth uses PKCE (RFC 7636) for secure authorization with YNAB
- OAuth state bound to session via SHA-256 hash cookie (prevents CSRF on callback)
- HMAC-signed cookies for client approval persistence (`COOKIE_ENCRYPTION_KEY`)
- `Authorization` headers set by agent code are stripped and replaced by `GlobalOutbound`

## Testing

Tests use **vitest** with `@cloudflare/vitest-pool-workers`.

```bash
npm run test          # Single run
npm run test:watch    # Watch mode
```

**Test coverage areas:**
- Worker code generation (search and execute templates)
- Spec processor (`$ref` resolution, circular reference handling, extension stripping)
- Response truncation (size limits, null/undefined handling, truncation notices)

## Contributing

### Pre-merge checklist

Run all checks before considering work done:

```bash
npm run check   # format:check + lint + typecheck + test
```

### Boundaries

**Always:**

- Run `npm run check` before considering work done
- Add tests for new functionality
- Consider security implications -- this handles OAuth tokens and API calls
- Use Zod for runtime validation of external data
- Run `npm run build:spec` after modifying spec processing logic

**Ask first:**

- Adding new dependencies
- Changing authentication flows or token handling
- Modifying the OpenAPI spec processing pipeline
- Changing deployment configuration or bindings

**Never:**

- Hardcode secrets or API keys
- Allow user code to access YNAB API tokens directly
- Bypass `GlobalOutbound` network restrictions
- Force push to main

## Keeping AGENTS.md updated

Update this file when:

- Adding new modules or significant features
- Changing project structure
- Modifying build/test tooling
- Adding new code patterns or conventions
- Changing contribution workflows
