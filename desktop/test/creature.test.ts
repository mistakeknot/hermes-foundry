import { describe, expect, it } from 'vitest'
import { buildCreature, layoutCreatures, natCompare } from '../src/creature'
import { buildFixture } from '../src/mock'

const fx = buildFixture()
const proj = (id: string) => fx.projects.find((p) => p.id === id)!

describe('creature builder', () => {
  it('is deterministic: same project, same creature', () => {
    expect(buildCreature(proj('main'))).toEqual(buildCreature(structuredClone(proj('main'))))
  })
  it('different project ids give different creatures', () => {
    const a = buildCreature({ ...proj('main'), id: 'main' })
    const b = buildCreature({ ...proj('main'), id: 'other' })
    expect(a.seed).not.toBe(b.seed)
    expect(a.torso.radii).not.toEqual(b.torso.radii)
  })
  it('one limb per epic, one scale per card, one carving per doc', () => {
    for (const p of fx.projects) {
      const c = buildCreature(p)
      const stray = p.cards.some((x) => !x.epic_id)
      expect(c.limbs.length).toBe(p.epics.length + (stray ? 1 : 0))
      expect(c.limbs.reduce((n, l) => n + l.scales.length, 0)).toBe(p.cards.length)
      expect(c.limbs.reduce((n, l) => n + l.carvings.length, 0)).toBe(p.cards.reduce((n, x) => n + x.docs.length, 0))
    }
  })
  it('status changes recolour but never move a scale', () => {
    const p = structuredClone(proj('main'))
    const before = buildCreature(p)
    p.cards[0].status = 'done'; p.cards[0].status_native = 'done'
    p.cards[1].claimed_by = 'fx:9'
    const after = buildCreature(p)
    expect(after.limbs.map((l) => l.scales)).toEqual(before.limbs.map((l) => l.scales))
  })
  it('card order in the input does not change the creature', () => {
    const p = structuredClone(proj('docs'))
    const a = buildCreature(p)
    p.cards.reverse()
    expect(buildCreature(p).limbs.map((l) => l.scales)).toEqual(a.limbs.map((l) => l.scales))
  })
  it('status counts add up per limb', () => {
    const c = buildCreature(proj('main'))
    for (const l of c.limbs) expect(Object.values(l.counts).reduce((a, b) => a + b, 0)).toBe(l.scales.length)
  })
  it('stays finite and bounded with 400 cards on one epic', () => {
    const big = structuredClone(proj('main'))
    const base = big.cards[0]
    big.cards = Array.from({ length: 400 }, (_, i) => ({ ...base, id: `main:b${i}`, epic_id: big.epics[0].id }))
    const c = buildCreature(big)
    for (const l of c.limbs) for (const s of l.scales) { expect(s.pos.every(Number.isFinite)).toBe(true); expect(s.size).toBeGreaterThan(0) }
    expect(c.limbs[0].path.length).toBeGreaterThan(1)
    expect(Math.max(...c.limbs.flatMap((l) => l.path.map((q) => Math.abs(q[1]))))).toBeLessThan(20)
  })
  it('handles an empty project', () => {
    const c = buildCreature({ id: 'empty', name: 'Empty', epics: [], cards: [] })
    expect(c.limbs).toEqual([])
  })
  it('natural sort orders t2 before t10', () => {
    expect(['t10', 't2', 't1'].sort(natCompare)).toEqual(['t1', 't2', 't10'])
  })
  it('layout is deterministic and gives one spot per creature', () => {
    const specs = fx.projects.map(buildCreature)
    expect(layoutCreatures(specs)).toEqual(layoutCreatures(specs))
    expect(layoutCreatures(specs).length).toBe(3)
  })
})
