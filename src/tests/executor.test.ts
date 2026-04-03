import { describe, it, expect } from 'vitest'
import { buildSearchWorkerCode, buildExecuteWorkerCode } from '../executor'

describe('buildSearchWorkerCode', () => {
  it('embeds spec and agent code in worker template', () => {
    const spec = { paths: { '/test': { get: { summary: 'Test' } } } }
    const code = buildSearchWorkerCode(JSON.stringify(spec), 'return Object.keys(spec.paths)')
    expect(code).toContain('spec')
    expect(code).toContain('WorkerEntrypoint')
    expect(code).toContain('Object.keys(spec.paths)')
  })
})

describe('buildExecuteWorkerCode', () => {
  it('embeds apiBase and ynab.request helper', () => {
    const code = buildExecuteWorkerCode(
      'https://api.ynab.com/v1',
      'return await ynab.request("/plans")'
    )
    expect(code).toContain('ynab')
    expect(code).toContain('request')
    expect(code).toContain('https://api.ynab.com/v1')
  })

  it('includes query param handling via URL.searchParams', () => {
    const code = buildExecuteWorkerCode('https://api.ynab.com/v1', 'return 1')
    expect(code).toContain('searchParams.set')
  })

  it('includes YNAB error normalization', () => {
    const code = buildExecuteWorkerCode('https://api.ynab.com/v1', 'return 1')
    expect(code).toContain('error')
    expect(code).toContain('detail')
    expect(code).toContain('429')
  })
})
