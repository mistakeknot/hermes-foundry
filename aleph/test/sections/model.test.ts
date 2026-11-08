import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeName, parseDoc, unsortedCards } from '../../src/sections'
import { checkCardId, trimName } from '../../src/sections/model'

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

describe('shared name cases (tests/fixtures/sections/names.json, also read by the Python tests)', () => {
  const cases = JSON.parse(readFileSync(path.join(FIXTURES, 'names.json'), 'utf8')) as Array<{ input: string; ok: boolean; normalized?: string }>
  it.each(cases.map((c) => [JSON.stringify(c.input), c] as const))('%s', (_label, c) => {
    if (c.ok) expect(normalizeName(c.input)).toBe(c.normalized)
    else expect(() => normalizeName(c.input)).toThrowError(expect.objectContaining({ code: 'invalid_name' }))
  })
  it('rejects a lone surrogate as a card id too', () => {
    expect(() => checkCardId('atlas:\ud800')).toThrowError(expect.objectContaining({ code: 'invalid_id' }))
    expect(checkCardId('atlas:\ud83d\ude00')).toBe('atlas:\ud83d\ude00')
  })
})

describe('the trimmed whitespace set (tests/fixtures/sections/whitespace.json, also read by the Python tests)', () => {
  const fixture = JSON.parse(readFileSync(path.join(FIXTURES, 'whitespace.json'), 'utf8')) as { codePoints: number[] }
  it('is exactly the fixture list, over every BMP code point', () => {
    const trimmed: number[] = []
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue
      const probe = String.fromCharCode(cp)
      if (trimName(probe + 'x' + probe) === 'x') trimmed.push(cp)
    }
    expect(trimmed).toEqual(fixture.codePoints)
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
