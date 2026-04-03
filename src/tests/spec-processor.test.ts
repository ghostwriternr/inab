import { describe, it, expect } from 'vitest'
import { resolveRefs, processSpec } from '../spec-processor'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helpers for loose JSON types
const r = (obj: unknown) => obj as any

describe('resolveRefs', () => {
  it('resolves a simple $ref', () => {
    const spec = {
      paths: { '/test': { get: { $ref: '#/components/schemas/T' } } },
      components: { schemas: { T: { type: 'object', properties: { id: { type: 'string' } } } } }
    }
    const resolved = r(resolveRefs(spec))
    expect(resolved.paths['/test'].get).toEqual({ type: 'object', properties: { id: { type: 'string' } } })
  })

  it('resolves nested $refs', () => {
    const spec = {
      paths: { '/test': { $ref: '#/components/paths/TP' } },
      components: {
        paths: { TP: { get: { responses: { 200: { $ref: '#/components/responses/OK' } } } } },
        responses: { OK: { description: 'OK' } }
      }
    }
    const resolved = r(resolveRefs(spec))
    expect(resolved.paths['/test'].get.responses[200]).toEqual({ description: 'OK' })
  })

  it('handles circular references without infinite loop', () => {
    const spec = {
      components: { schemas: { Node: { type: 'object', properties: { child: { $ref: '#/components/schemas/Node' } } } } }
    }
    const resolved = r(resolveRefs(spec))
    expect(resolved.components.schemas.Node.properties.child).toBeDefined()
  })

  it('resolves the same $ref used in multiple places independently', () => {
    const spec = {
      paths: {
        '/a': { get: { response: { $ref: '#/components/schemas/Shared' } } },
        '/b': { get: { response: { $ref: '#/components/schemas/Shared' } } }
      },
      components: { schemas: { Shared: { type: 'string' } } }
    }
    const resolved = r(resolveRefs(spec))
    expect(resolved.paths['/a'].get.response).toEqual({ type: 'string' })
    expect(resolved.paths['/b'].get.response).toEqual({ type: 'string' })
  })
})

describe('processSpec', () => {
  it('retains paths, operations, parameters, and schemas', () => {
    const raw = {
      openapi: '3.1.1', info: { title: 'YNAB', version: '1.82.0' },
      paths: { '/plans': { get: { summary: 'List', parameters: [{ name: 'x', in: 'query' }], responses: { 200: { description: 'OK' } } } } },
      components: { schemas: { Plan: { type: 'object' } } }
    }
    const processed = r(processSpec(raw))
    expect(processed.paths['/plans'].get.summary).toBe('List')
    expect(processed.paths['/plans'].get.parameters).toBeDefined()
    expect(processed.components.schemas.Plan).toBeDefined()
  })

  it('strips x- extension fields', () => {
    const raw = {
      openapi: '3.1.1', info: { title: 'T', version: '1.0' },
      paths: { '/test': { get: { summary: 'T', 'x-custom': 'remove', responses: {} } } },
      components: { schemas: {} }
    }
    const processed = r(processSpec(raw))
    expect(processed.paths['/test'].get['x-custom']).toBeUndefined()
  })
})
