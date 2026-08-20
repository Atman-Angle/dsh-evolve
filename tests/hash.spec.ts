import { describe, expect, it } from 'vitest'
import { collapseWhitespace, fingerprint, normalizeText, stripAnsi, textFingerprint } from '../src/features/hash.js'

describe('fingerprint', () => {
  it('is stable across calls', () => {
    expect(fingerprint('hello')).toBe(fingerprint('hello'))
  })

  it('distinguishes distinct inputs', () => {
    expect(fingerprint('a')).not.toBe(fingerprint('b'))
  })

  it('hashes empty input deterministically', () => {
    expect(fingerprint('')).toBe(fingerprint(''))
  })
})

describe('normalizeText', () => {
  it('collapses whitespace', () => {
    expect(normalizeText('a\n  b\t c')).toBe('a b c')
  })

  it('strips ANSI escapes', () => {
    expect(normalizeText('\u001B[31mred\u001B[0m text')).toBe('red text')
  })

  it('caps length', () => {
    const long = 'x'.repeat(10_000)
    expect(normalizeText(long, 100)).toHaveLength(100)
  })
})

describe('textFingerprint', () => {
  it('is whitespace-insensitive', () => {
    expect(textFingerprint('a  b\nc')).toBe(textFingerprint('a b c'))
  })

  it('is ANSI-insensitive', () => {
    expect(textFingerprint('\u001B[1mok\u001B[0m')).toBe(textFingerprint('ok'))
  })
})

describe('collapseWhitespace', () => {
  it('trims and collapses', () => {
    expect(collapseWhitespace('  x\n y ')).toBe('x y')
  })
})