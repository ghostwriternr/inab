import { describe, it, expect } from 'vitest'
import { truncateContent } from '../truncate'

describe('truncateContent', () => {
  it('returns short strings unchanged', () => {
    expect(truncateContent('hello world')).toBe('hello world')
  })

  it('returns short objects as JSON unchanged', () => {
    const input = { foo: 'bar' }
    expect(truncateContent(input)).toBe(JSON.stringify(input, null, 2))
  })

  it('truncates strings exceeding the token limit', () => {
    const input = 'x'.repeat(30000)
    const result = truncateContent(input)
    expect(result.length).toBeLessThan(30000)
    expect(result).toContain('TRUNCATED')
    expect(result).toContain('30000')
  })

  it('truncates objects exceeding the token limit', () => {
    const input = { data: 'x'.repeat(30000) }
    const result = truncateContent(input)
    expect(result).toContain('TRUNCATED')
  })

  it('includes original size in truncation notice', () => {
    const input = 'y'.repeat(30000)
    const result = truncateContent(input)
    expect(result).toMatch(/original.*30000/i)
  })

  it('suggests filtering strategies in truncation notice', () => {
    const result = truncateContent('x'.repeat(30000))
    expect(result).toContain('server_knowledge')
  })

  it('handles null and undefined gracefully', () => {
    expect(truncateContent(null)).toBe('null')
    expect(truncateContent(undefined)).toBe('undefined')
  })
})
