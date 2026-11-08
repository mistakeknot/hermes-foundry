// The contract every SectionsBackend must pass. A backend's own test file calls runSectionsContract with a factory:
//
//   runSectionsContract('my backend', async () => ({ backend, creatures: ['atlas', 'harbor'], cleanup }))
//
// `creatures` are two creature ids the backend accepts for reads and writes (board slugs, so a file backend works too).
// Behaviour specific to one backend (a missing board directory, a corrupt file, atomic writes) belongs in that backend's own tests.
import { afterEach, describe, expect, it } from 'vitest'
import { SectionsError, unsortedCards, type SectionsBackend } from '../../src/sections'

export interface ContractSubject {
  backend: SectionsBackend
  creatures: [string, string]
  cleanup?: () => Promise<void>
}

async function code(p: Promise<unknown>): Promise<string> {
  try { await p } catch (e) { return e instanceof SectionsError ? e.code : `non-sections error: ${String(e)}` }
  return 'resolved'
}

export function runSectionsContract(name: string, make: () => Promise<ContractSubject>): void {
  describe(`sections contract: ${name}`, () => {
    const cleanups: Array<() => Promise<void>> = []
    afterEach(async () => { for (const c of cleanups.splice(0)) await c() })
    async function subject(): Promise<ContractSubject> {
      const s = await make()
      if (s.cleanup) cleanups.push(s.cleanup)
      return s
    }

    it('lists nothing for a creature with no sections', async () => {
      const { backend, creatures: [a] } = await subject()
      expect(await backend.list(a)).toEqual([])
    })

    it('creates sections with fresh ids, in creation order, trimming the name', async () => {
      const { backend, creatures: [a] } = await subject()
      const docs = await backend.create(a, '  Docs ')
      const ship = await backend.create(a, 'Ship')
      expect(docs).toMatchObject({ name: 'Docs', cardIds: [] })
      expect(docs.id).not.toBe(ship.id)
      expect(await backend.list(a)).toEqual([docs, ship])
    })

    it('keeps each creature separate', async () => {
      const { backend, creatures: [a, b] } = await subject()
      await backend.create(a, 'Docs')
      expect(await backend.list(b)).toEqual([])
      const same = await backend.create(b, 'Docs') // the same name in another creature is fine
      expect((await backend.list(b)).map((s) => s.id)).toEqual([same.id])
    })

    it.each(['', '   ', 'x'.repeat(81), 'tab\there', 'Unsorted', ' unsorted '])('rejects the name %j', async (bad) => {
      const { backend, creatures: [a] } = await subject()
      expect(await code(backend.create(a, bad))).toBe('invalid_name')
      expect(await backend.list(a)).toEqual([])
    })

    it('accepts an 80-character name', async () => {
      const { backend, creatures: [a] } = await subject()
      expect((await backend.create(a, 'x'.repeat(80))).name).toHaveLength(80)
    })

    it('rejects a duplicate name, ignoring case and surrounding space', async () => {
      const { backend, creatures: [a] } = await subject()
      await backend.create(a, 'Docs')
      expect(await code(backend.create(a, 'docs'))).toBe('duplicate_name')
      expect(await code(backend.create(a, ' DOCS '))).toBe('duplicate_name')
      expect(await backend.list(a)).toHaveLength(1)
    })

    it('renames a section, keeping its id, place and cards', async () => {
      const { backend, creatures: [a] } = await subject()
      const docs = await backend.create(a, 'Docs')
      const ship = await backend.create(a, 'Ship')
      await backend.moveCard(a, 'atlas:t_1', docs.id)
      const renamed = await backend.rename(a, docs.id, ' Documentation ')
      expect(renamed).toEqual({ id: docs.id, name: 'Documentation', cardIds: ['atlas:t_1'] })
      expect(await backend.list(a)).toEqual([renamed, ship])
    })

    it('lets a section be renamed to its own name or another case of it, but not to a sibling\'s', async () => {
      const { backend, creatures: [a] } = await subject()
      const docs = await backend.create(a, 'Docs')
      await backend.create(a, 'Ship')
      expect((await backend.rename(a, docs.id, 'Docs')).name).toBe('Docs')
      expect((await backend.rename(a, docs.id, 'DOCS')).name).toBe('DOCS')
      expect(await code(backend.rename(a, docs.id, 'ship'))).toBe('duplicate_name')
      expect(await code(backend.rename(a, docs.id, 'Unsorted'))).toBe('invalid_name')
      expect(await code(backend.rename(a, docs.id, ''))).toBe('invalid_name')
      expect((await backend.list(a))[0].name).toBe('DOCS')
    })

    it('rejects renaming or deleting a section that does not exist, or that belongs to another creature', async () => {
      const { backend, creatures: [a, b] } = await subject()
      const docs = await backend.create(a, 'Docs')
      expect(await code(backend.rename(a, 's_deadbeef', 'X'))).toBe('not_found')
      expect(await code(backend.remove(a, 's_deadbeef'))).toBe('not_found')
      expect(await code(backend.rename(b, docs.id, 'X'))).toBe('not_found')
      expect(await code(backend.remove(b, docs.id))).toBe('not_found')
      expect((await backend.list(a))[0].name).toBe('Docs')
    })

    it('moves a card into a section, and a later move takes it out of the first (a card is in one section)', async () => {
      const { backend, creatures: [a] } = await subject()
      const docs = await backend.create(a, 'Docs')
      const ship = await backend.create(a, 'Ship')
      await backend.moveCard(a, 'atlas:t_1', docs.id)
      await backend.moveCard(a, 'atlas:t_2', docs.id)
      expect((await backend.list(a)).map((s) => s.cardIds)).toEqual([['atlas:t_1', 'atlas:t_2'], []])
      await backend.moveCard(a, 'atlas:t_1', ship.id)
      expect((await backend.list(a)).map((s) => s.cardIds)).toEqual([['atlas:t_2'], ['atlas:t_1']])
    })

    it('moving a card to the section it is already in puts it last, without duplicating it', async () => {
      const { backend, creatures: [a] } = await subject()
      const docs = await backend.create(a, 'Docs')
      await backend.moveCard(a, 'atlas:t_1', docs.id)
      await backend.moveCard(a, 'atlas:t_2', docs.id)
      await backend.moveCard(a, 'atlas:t_1', docs.id)
      expect((await backend.list(a))[0].cardIds).toEqual(['atlas:t_2', 'atlas:t_1'])
    })

    it('moves a card to Unsorted with null, and null for a card in no section is fine', async () => {
      const { backend, creatures: [a] } = await subject()
      const docs = await backend.create(a, 'Docs')
      await backend.moveCard(a, 'atlas:t_1', docs.id)
      await backend.moveCard(a, 'atlas:t_1', null)
      await backend.moveCard(a, 'atlas:t_9', null)
      expect((await backend.list(a))[0].cardIds).toEqual([])
    })

    it('rejects moving a card into an unknown section, leaving the card where it was', async () => {
      const { backend, creatures: [a] } = await subject()
      const docs = await backend.create(a, 'Docs')
      await backend.moveCard(a, 'atlas:t_1', docs.id)
      expect(await code(backend.moveCard(a, 'atlas:t_1', 's_deadbeef'))).toBe('not_found')
      expect((await backend.list(a))[0].cardIds).toEqual(['atlas:t_1'])
    })

    it.each(['', 'x'.repeat(201), 'a\nb'])('rejects the card id %j', async (bad) => {
      const { backend, creatures: [a] } = await subject()
      const docs = await backend.create(a, 'Docs')
      expect(await code(backend.moveCard(a, bad, docs.id))).toBe('invalid_id')
    })

    it('deleting a section sends its cards to Unsorted and touches no other section', async () => {
      const { backend, creatures: [a] } = await subject()
      const docs = await backend.create(a, 'Docs')
      const ship = await backend.create(a, 'Ship')
      await backend.moveCard(a, 'atlas:t_1', docs.id)
      await backend.moveCard(a, 'atlas:t_2', ship.id)
      await backend.remove(a, docs.id)
      const left = await backend.list(a)
      expect(left).toEqual([{ id: ship.id, name: 'Ship', cardIds: ['atlas:t_2'] }])
      expect(unsortedCards(left, ['atlas:t_1', 'atlas:t_2', 'atlas:t_3'])).toEqual(['atlas:t_1', 'atlas:t_3'])
      expect(await code(backend.remove(a, docs.id))).toBe('not_found')
    })

    it('frees a deleted section\'s name for reuse', async () => {
      const { backend, creatures: [a] } = await subject()
      const docs = await backend.create(a, 'Docs')
      await backend.remove(a, docs.id)
      const again = await backend.create(a, 'Docs')
      expect(again.id).not.toBe(docs.id)
    })

    it('computes Unsorted from the card list and never stores it', async () => {
      const { backend, creatures: [a] } = await subject()
      const docs = await backend.create(a, 'Docs')
      await backend.moveCard(a, 'atlas:t_2', docs.id)
      const sections = await backend.list(a)
      expect(sections.map((s) => s.name)).toEqual(['Docs']) // no "Unsorted" entry
      expect(unsortedCards(sections, ['atlas:t_1', 'atlas:t_2', 'atlas:t_3'])).toEqual(['atlas:t_1', 'atlas:t_3'])
      expect(unsortedCards(sections, [])).toEqual([]) // a stored card the host no longer lists is ignored
    })

    it('hands back copies: changing a returned section does not change the stored one', async () => {
      const { backend, creatures: [a] } = await subject()
      const docs = await backend.create(a, 'Docs')
      docs.cardIds.push('atlas:t_1')
      docs.name = 'Mutated'
      const listed = await backend.list(a)
      listed[0].cardIds.push('atlas:t_2')
      expect(await backend.list(a)).toEqual([{ id: docs.id, name: 'Docs', cardIds: [] }])
    })

    it('stays consistent under concurrent calls', async () => {
      const { backend, creatures: [a] } = await subject()
      const made = await Promise.all(['A', 'B', 'C', 'D'].map((n) => backend.create(a, n)))
      expect(new Set((await backend.list(a)).map((s) => s.name))).toEqual(new Set(['A', 'B', 'C', 'D']))
      await Promise.all(made.map((s, i) => backend.moveCard(a, `atlas:t_${i}`, s.id)))
      const dup = await Promise.all([backend.create(a, 'Same'), backend.create(a, 'same')].map(code))
      expect(dup.sort()).toEqual(['duplicate_name', 'resolved'])
      const all = await backend.list(a)
      expect(all.flatMap((s) => s.cardIds).sort()).toEqual(['atlas:t_0', 'atlas:t_1', 'atlas:t_2', 'atlas:t_3'])
    })
  })
}
