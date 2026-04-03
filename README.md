# inab

A token-efficient MCP server exposing the full YNAB API via two code-mode tools (search + execute). Deployed to Cloudflare Workers.

## Setup

1. Register a YNAB OAuth app at https://app.ynab.com/settings/developer
   - Set redirect URI to `https://your-worker.example.com/ynab/callback`
2. Set secrets:
   ```bash
   npx wrangler secret put YNAB_CLIENT_ID
   npx wrangler secret put YNAB_CLIENT_SECRET
   npx wrangler secret put COOKIE_ENCRYPTION_KEY
   ```
3. Create KV namespace and update ID in `wrangler.jsonc`:
   ```bash
   npx wrangler kv namespace create OAUTH_KV
   ```
4. Build the spec and deploy:
   ```bash
   npm run build:spec
   npm run deploy
   ```

## Development

```bash
npm install
npm run build:spec   # Fetch and process YNAB OpenAPI spec
npm run dev          # Start local dev server
npm run check        # Run all checks (format, lint, typecheck, test)
```

## Connecting MCP Clients

### Claude Code
```bash
claude mcp add --transport http ynab https://your-worker.example.com/mcp
```

### Claude.ai
Add as a custom connector at Settings > Connectors with the Worker URL.

## Architecture

Two-tool code-mode pattern: agents write JavaScript to query the OpenAPI spec (search) or call the API (execute). See [design spec](docs/superpowers/specs/2026-04-03-ynab-mcp-design.md) for full architecture details.
