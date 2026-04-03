import { exports } from 'cloudflare:workers'
import { describe, it, expect } from 'vitest'

describe('Health check', () => {
  it('GET / responds with inab', async () => {
    const response = await exports.default.fetch('http://localhost/')
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('inab')
  })
})

describe('MCP endpoint auth', () => {
  it('POST /mcp returns 401 without auth token', async () => {
    const response = await exports.default.fetch('http://localhost/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
    })
    expect(response.status).toBe(401)
  })
})

describe('Origin validation', () => {
  it('allows requests without Origin header (CLI clients)', async () => {
    const response = await exports.default.fetch('http://localhost/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
    })
    // Should pass Origin check (may still fail auth with 401)
    expect(response.status).not.toBe(403)
  })
})

describe('OAuth endpoints', () => {
  it('GET /authorize without client_id returns error', async () => {
    const response = await exports.default.fetch('http://localhost/authorize')
    expect(response.status).toBeGreaterThanOrEqual(400)
  })
})
