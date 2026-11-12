import { describe, expect, it } from 'vitest'
import { buildCreature, LINEAGES, lineageTraits, pickLineage } from '../src/creature'
import { buildFixture } from '../src/mock'

const project = buildFixture().projects[0]

describe('lineage selection', () => {
  it('bundles only the approved fields of 48 complete, unique lineages', () => {
    expect(LINEAGES).toHaveLength(48)
    expect(new Set(LINEAGES.map(c => c.id)).size).toBe(48)
    for (const c of LINEAGES) {
      expect(Object.keys(c).sort()).toEqual(['eidogen', 'id', 'motifs', 'name'])
      expect(c.motifs.length).toBeGreaterThan(0)
      expect(Object.keys(c.eidogen)).toHaveLength(29)
      expect(Object.values(c.eidogen).every(v => v === 'not-applicable' || typeof v === 'number' && v >= 0 && v <= 1)).toBe(true)
    }
  })
  it('has stable seeded picks, independent of catalogue order', () => {
    expect(pickLineage('fixture-project')).toMatchSnapshot()
    expect(pickLineage('fixture-project', {}, [...LINEAGES].reverse())).toEqual(pickLineage('fixture-project'))
    expect(pickLineage('fixture-project', { reroll: 1 })).not.toEqual(pickLineage('fixture-project'))
    expect(pickLineage('fixture-project', { reroll: 1 })).toEqual(pickLineage('fixture-project', { reroll: 1 }))
  })
  it('chooses by case-insensitive name or id, and handles unavailable lineage', () => {
    expect(pickLineage('p', { name: '  phoenix ' })?.name).toBe('Phoenix')
    expect(pickLineage('p', { name: '1_phoenix' })?.name).toBe('Phoenix')
    expect(pickLineage('p', { name: 'missing' })).toBeUndefined()
    expect(pickLineage('p', {}, [])).toBeUndefined()
    expect(pickLineage('p', { reroll: NaN })).toEqual(pickLineage('p'))
  })
})

describe('lineage geometry', () => {
  it('retains the legacy generator exactly when lineage is disabled or unavailable', () => {
    const legacy = buildCreature({ ...project, lineage: null })
    expect(legacy).toMatchSnapshot()
    expect(buildCreature({ ...project, lineage: { name: 'missing' } })).toEqual(legacy)
  })
  it('has a fixed geometry fixture and retains the project display name', () => {
    const spec = buildCreature({ ...project, lineage: { name: 'Phoenix' } })
    expect(spec.lineage?.name).toBe('Phoenix')
    expect(spec.name).toBe(project.name)
    expect(spec).toMatchSnapshot()
  })
  it('motifs change body shape while eidogen changes proportions and palette', () => {
    const phoenix = LINEAGES.find(c => c.name === 'Phoenix')!
    const kraken = LINEAGES.find(c => c.name === 'Kraken')!
    const a = buildCreature({ ...project, lineage: { name: phoenix.name } })
    const b = buildCreature({ ...project, lineage: { name: kraken.name } })
    expect(a.torso.radii).not.toEqual(b.torso.radii)
    expect(a.torso.lumps).not.toEqual(b.torso.lumps)
    expect(a.limbs.map(l => l.path)).not.toEqual(b.limbs.map(l => l.path))
    expect(new Set(LINEAGES.map(c => buildCreature({ ...project, lineage: { name: c.name } }).torso.material)).size).toBe(3)
  })
  it('isolates motif deformation from eidogen proportions and colour', () => {
    const c = LINEAGES[0]
    const base = { ...c, motifs: [], eidogen: {} }
    const neutral = lineageTraits(base)
    expect(lineageTraits({ ...base, motifs: ['giant-wingspan'] }).lift).toBeGreaterThan(neutral.lift)
    expect(lineageTraits({ ...base, motifs: ['octopus-like-sea-monster-form'] }).sway).toBeGreaterThan(neutral.sway)
    expect(lineageTraits({ ...base, motifs: ['single-spiraling-horn'] }).lumps).toBeGreaterThan(neutral.lumps)
    const warm = lineageTraits({ ...base, eidogen: { Empathy: 1, Nurturing: 1, 'Emotional Processing': 1, Resilience: 1 } })
    const cool = lineageTraits({ ...base, eidogen: { Empathy: 0, Nurturing: 0, 'Emotional Processing': 0, Resilience: 0 } })
    expect(warm.material).toBe('coral')
    expect(cool.material).toBe('stone')
    expect(warm.stretch[1]).toBeGreaterThan(cool.stretch[1])
    expect(lineageTraits({ ...base, eidogen: { Resilience: 'not-applicable' } })).toEqual(neutral)
  })
  it('all lineages preserve card ownership, finite geometry and status stability', () => {
    for (const c of LINEAGES) {
      const p = { ...structuredClone(project), lineage: { name: c.name } }
      const before = buildCreature(p)
      p.cards.forEach(card => { card.status = 'done' })
      const after = buildCreature(p)
      expect(after.limbs.map(l => l.scales)).toEqual(before.limbs.map(l => l.scales))
      expect(before.limbs.flatMap(l => l.scales.map(s => s.cardId)).sort()).toEqual(p.cards.map(c => c.id).sort())
      expect(before.limbs.flatMap(l => l.path.flat()).every(Number.isFinite)).toBe(true)
      expect(before.height).toBeLessThan(20)
      expect(before.radius).toBeLessThan(25)
    }
  })
})
