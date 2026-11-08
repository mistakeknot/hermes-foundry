import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeName, parseDoc, unsortedCards } from '../../src/sections'

// The same fixture files are read by tests/test_sections.py, so the TypeScript writer and the Python reader agree on the format.
const FIXTURES = path.resolve(__dirname, '../../../tests/fixtures/sections')
const load = (kind: string, file: string): unknown => JSON.parse(readFileSync(path.join(FIXTURES, kind, file), 'utf8'))

describe('the sections file format', () => {
  const valid = readdirSync(path.join(FIXTURES, 'valid'))
  const invalid = readdirSync(path.join(FIXTURES, 'invalid'))
  it('has fixtures to check', () => {
    expect(valid.length).toBeGreaterThanOrEqual(2)
    expect(invalid.length).toBeGreaterThanOrEqual(10)
  })
  it.each(valid)('accepts valid/%s unchanged', (f) => {
    const raw = load('valid', f)
    expect(parseDoc(raw)).toEqual(raw)
  })
  it.each(invalid)('rejects invalid/%s as corrupt', (f) => {
    expect(() => parseDoc(load('invalid', f))).toThrowError(expect.objectContaining({ code: 'corrupt' }))
  })
})

describe('normalizeName', () => {
  it('trims and keeps inner spacing and case', () => {
    expect(normalizeName('  Release  prep ')).toBe('Release  prep')
  })
  it('rejects non-strings', () => {
    expect(() => normalizeName(7)).toThrowError(expect.objectContaining({ code: 'invalid_name' }))
  })
})

describe('unsortedCards', () => {
  it('keeps the host order and drops sorted cards', () => {
    const s = [{ id: 's_00000001', name: 'A', cardIds: ['c2'] }]
    expect(unsortedCards(s, ['c3', 'c2', 'c1'])).toEqual(['c3', 'c1'])
  })
})
