type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
type JsonObject = { [key: string]: JsonValue }

export function resolveRefs(spec: JsonObject): JsonObject {
  function lookupRef(ref: string, root: JsonObject): JsonValue {
    const path = ref.replace('#/', '').split('/')
    let current: JsonValue = root
    for (const segment of path) {
      if (current && typeof current === 'object' && !Array.isArray(current)) {
        current = (current as JsonObject)[segment]
      } else {
        return { $ref: ref, _unresolved: true } as unknown as JsonValue
      }
    }
    return current
  }

  function resolve(node: JsonValue, root: JsonObject, refPath: Set<string>): JsonValue {
    if (node === null || typeof node !== 'object') return node

    if (Array.isArray(node)) {
      return node.map((item) => resolve(item, root, refPath))
    }

    const obj = node as JsonObject

    if (typeof obj.$ref === 'string') {
      const ref = obj.$ref as string
      if (refPath.has(ref)) {
        return { _circular: ref } as unknown as JsonValue
      }
      const resolved = lookupRef(ref, root)
      if (resolved && typeof resolved === 'object' && !Array.isArray(resolved)) {
        const newPath = new Set(refPath)
        newPath.add(ref)
        return resolve(resolved, root, newPath)
      }
      return resolved
    }

    const result: JsonObject = {}
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolve(value, root, refPath)
    }
    return result
  }

  return resolve(spec, spec, new Set()) as JsonObject
}

export function processSpec(raw: JsonObject): JsonObject {
  const resolved = resolveRefs(raw)

  function stripExtensions(obj: JsonValue): JsonValue {
    if (obj === null || typeof obj !== 'object') return obj
    if (Array.isArray(obj)) return obj.map(stripExtensions)
    const result: JsonObject = {}
    for (const [key, value] of Object.entries(obj as JsonObject)) {
      if (key.startsWith('x-')) continue
      result[key] = stripExtensions(value)
    }
    return result
  }

  const stripped = stripExtensions(resolved) as JsonObject
  return {
    paths: stripped.paths ?? {},
    components: { schemas: ((stripped.components as JsonObject)?.schemas as JsonObject) ?? {} }
  }
}
