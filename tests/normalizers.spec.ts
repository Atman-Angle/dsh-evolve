import { describe, expect, it } from 'vitest'
import { actionKey, canonicalArguments, parseArguments, sortJsonValue } from '../src/features/invocation-normalizer.js'
import { errorSignatureKey } from '../src/features/error-normalizer.js'

describe('canonicalArguments', () => {
  it('ignores JSON key order', () => {
    expect(canonicalArguments('{"b":1,"a":2}')).toBe(canonicalArguments('{"a":2,"b":1}'))
  })

  it('normalizes nested objects recursively', () => {
    expect(canonicalArguments('{"z":{"y":[1,2],"x":3}}')).toBe(canonicalArguments('{"z":{"x":3,"y":[1,2]}}'))
  })

  it('treats malformed JSON as raw text', () => {
    const raw = '{not json'
    expect(canonicalArguments(raw)).toBe(JSON.stringify(raw))
  })

  it('maps empty string to empty object', () => {
    expect(canonicalArguments('')).toBe('{}')
  })
})

describe('parseArguments', () => {
  it('parses valid JSON', () => {
    expect(parseArguments('{"a":1}')).toEqual({ a: 1 })
  })

  it('falls back to raw string on malformed JSON', () => {
    expect(parseArguments('{oops')).toBe('{oops')
  })
})

describe('sortJsonValue', () => {
  it('sorts object keys and keeps arrays ordered', () => {
    expect(sortJsonValue({ b: [2, 1], a: 1 })).toEqual({ a: 1, b: [2, 1] })
  })
})

describe('actionKey', () => {
  it('equal for equal calls with different key order', () => {
    expect(actionKey('grep', '{"pattern":"auth","path":"."}')).toBe(actionKey('grep', '{"path":".","pattern":"auth"}'))
  })

  it('differs across tools or arguments', () => {
    expect(actionKey('grep', '{"pattern":"auth"}')).not.toBe(actionKey('grep', '{"pattern":"b"}'))
    expect(actionKey('grep', '{}')).not.toBe(actionKey('find', '{}'))
  })
})

describe('errorSignatureKey', () => {
  it('stable for identical signatures', () => {
    const a = { tool: 'bash', code: 'MODULE_NOT_FOUND', text: 'Cannot find module x' }
    const b = { tool: 'bash', code: 'MODULE_NOT_FOUND', text: 'Cannot find module x' }
    expect(errorSignatureKey(a)).toBe(errorSignatureKey(b))
  })

  it('tolerates whitespace noise in error text', () => {
    expect(errorSignatureKey({ tool: 'bash', code: 'C1', text: 'a  b\nc' }))
      .toBe(errorSignatureKey({ tool: 'bash', code: 'C1', text: 'a b c' }))
  })

  it('differs across codes', () => {
    expect(errorSignatureKey({ code: 'C1', text: 'x' })).not.toBe(errorSignatureKey({ code: 'C2', text: 'x' }))
  })

  it('uses code or name as the structural basis', () => {
    expect(errorSignatureKey({ code: 'TOOL_TIMEOUT', text: 'timed out' }))
      .toBe(errorSignatureKey({ name: 'TOOL_TIMEOUT', text: 'timed out' }))
  })
})