import { describe, expect, it } from 'vitest'
import { BbSectionsBackend, SectionsError, scopedName, visibleName } from '../../src/sections'
import { runSectionsContract } from './contract'
import { FakeBb, FakeBbHttpError } from './fake-bb'

const seeded = () => new FakeBb({ threads: Array.from({ length: 10 }, (_, i) => [`atlas:t_${i}`, 'atlas'] as const) })

runSectionsContract('bb backend over a fake bb sdk', async () => ({ backend: new BbSectionsBackend(seeded()), creatures: ['atlas', 'harbor'] }))

async function code(p: Promise<unknown>): Promise<string> {
  try { await p } catch (e) { return e instanceof SectionsError ? e.code : `non-sections error: ${String(e)}` }
  return 'resolved'
}

describe('scoping', () => {
  it('stores sections under foundry/<creature>/<name> and shows only that creature\'s', async () => {
    const bb = seeded()
    const b = new BbSectionsBackend(bb)
    await b.create('atlas', 'Docs')
    expect(bb.rawSections().map((s) => s.name)).toEqual(['foundry/atlas/Docs'])
    expect(scopedName('atlas', 'Docs')).toBe('foundry/atlas/Docs')
  })

  it('does not show bb sections without the prefix, with another creature\'s, or with a malformed remainder', async () => {
    const bb = seeded()
    bb.addSection('Docs')
    bb.addSection('foundry/harbor/Docs')
    bb.addSection('foundry/atlas/')
    bb.addSection('foundry/atlas/ padded ')
    bb.addSection('foundry/atlas/Unsorted')
    bb.addSection('foundry/atlas2/Docs')
    bb.addSection('foundry/atlas/a/b') // a "/" inside the name is allowed: the creature id cannot contain one
    const b = new BbSectionsBackend(bb)
    expect((await b.list('atlas')).map((s) => s.name)).toEqual(['a/b'])
    expect((await b.list('harbor')).map((s) => s.name)).toEqual(['Docs'])
  })

  it('a section named like a Foundry one but made outside Foundry counts as a duplicate', async () => {
    const bb = seeded()
    bb.addSection('foundry/atlas/Docs')
    expect(await code(new BbSectionsBackend(bb).create('atlas', 'docs'))).toBe('duplicate_name')
    expect(await code(new BbSectionsBackend(bb).create('atlas', 'Docs'))).toBe('duplicate_name')
  })

  it('visibleName round-trips and rejects what it did not store', () => {
    expect(visibleName('atlas', scopedName('atlas', 'Docs'))).toBe('Docs')
    expect(visibleName('atlas', 'foundry/atlas/Docs ')).toBeNull()
    expect(visibleName('atlas', 'foundry/atlas/')).toBeNull()
    expect(visibleName('atlas', 'Docs')).toBeNull()
  })

  it.each(['', 'a/b', 'a b', 'x'.repeat(65)])('rejects the creature id %j', async (bad) => {
    const b = new BbSectionsBackend(seeded())
    expect(await code(b.list(bad))).toBe('invalid_id')
    expect(await code(b.create(bad, 'Docs'))).toBe('invalid_id')
  })
})

describe('bb behaviour', () => {
  it('maps the server\'s 409 to duplicate_name (a clash made between our check and the call)', async () => {
    const bb = seeded()
    const b = new BbSectionsBackend(bb)
    bb.failNext.set('threadSections.create', new FakeBbHttpError(409, 'section_name_conflict', 'taken'))
    expect(await code(b.create('atlas', 'Docs'))).toBe('duplicate_name')
    const docs = await b.create('atlas', 'Docs')
    const ship = await b.create('atlas', 'Ship')
    bb.failNext.set('threadSections.update', new FakeBbHttpError(409, 'section_name_conflict', 'taken'))
    expect(await code(b.rename('atlas', docs.id, 'Other'))).toBe('duplicate_name')
    expect(ship.name).toBe('Ship')
  })

  it('maps a 404 from bb to not_found and passes other errors through', async () => {
    const bb = seeded()
    const b = new BbSectionsBackend(bb)
    const docs = await b.create('atlas', 'Docs')
    bb.failNext.set('threadSections.delete', new FakeBbHttpError(404, 'section_not_found', 'gone'))
    expect(await code(b.remove('atlas', docs.id))).toBe('not_found')
    bb.failNext.set('threadSections.delete', new FakeBbHttpError(500, 'internal', 'boom'))
    expect(await code(b.remove('atlas', docs.id))).toMatch(/^non-sections error/)
    expect(await code(b.remove('atlas', docs.id))).toBe('resolved') // a failure does not wedge the write queue
  })

  it('lists sections in creation order although bb lists them by name', async () => {
    const b = new BbSectionsBackend(seeded())
    for (const n of ['Zebra', 'Apple', 'Mango']) await b.create('atlas', n)
    expect((await b.list('atlas')).map((s) => s.name)).toEqual(['Zebra', 'Apple', 'Mango'])
  })

  it('delete clears assignments and deletes no thread', async () => {
    const bb = seeded()
    const b = new BbSectionsBackend(bb)
    const docs = await b.create('atlas', 'Docs')
    await b.moveCard('atlas', 'atlas:t_1', docs.id)
    await b.remove('atlas', docs.id)
    expect(bb.rawThread('atlas:t_1')).toMatchObject({ sectionId: null })
    expect(bb.rawSections()).toEqual([])
  })

  it('rename keeps assignments (they follow the section id)', async () => {
    const bb = seeded()
    const b = new BbSectionsBackend(bb)
    const docs = await b.create('atlas', 'Docs')
    await b.moveCard('atlas', 'atlas:t_1', docs.id)
    await b.rename('atlas', docs.id, 'Guides')
    expect(bb.rawSections().map((s) => s.name)).toEqual(['foundry/atlas/Guides'])
    expect(bb.rawThread('atlas:t_1')?.sectionId).toBe(docs.id)
  })

  it('renaming to the section\'s own name makes no bb call', async () => {
    const bb = seeded()
    const b = new BbSectionsBackend(bb)
    const docs = await b.create('atlas', 'Docs')
    await b.rename('atlas', docs.id, ' Docs ')
    expect(bb.calls.filter((c) => c === 'threadSections.update')).toEqual([])
  })

  it('refuses to move another project\'s thread, and a thread bb does not know, into a section', async () => {
    const bb = seeded()
    bb.addThread('harbor:t_1', 'harbor')
    const b = new BbSectionsBackend(bb)
    const docs = await b.create('atlas', 'Docs')
    expect(await code(b.moveCard('atlas', 'harbor:t_1', docs.id))).toBe('not_found')
    expect(await code(b.moveCard('atlas', 'atlas:nope', docs.id))).toBe('not_found')
    expect(bb.rawThread('harbor:t_1')?.sectionId).toBeNull()
  })

  it('moving to Unsorted leaves a thread the user filed in a non-Foundry section alone', async () => {
    const bb = seeded()
    const mine = bb.addSection('Reading list')
    bb.addThread('atlas:t_20', 'atlas', mine.id)
    const b = new BbSectionsBackend(bb)
    await b.moveCard('atlas', 'atlas:t_20', null)
    expect(bb.rawThread('atlas:t_20')?.sectionId).toBe(mine.id)
    expect(bb.calls).not.toContain('threads.update')
  })

  it('moving a thread out of a Foundry section clears the assignment', async () => {
    const bb = seeded()
    const b = new BbSectionsBackend(bb)
    const docs = await b.create('atlas', 'Docs')
    await b.moveCard('atlas', 'atlas:t_1', docs.id)
    await b.moveCard('atlas', 'atlas:t_1', null)
    expect(bb.rawThread('atlas:t_1')?.sectionId).toBeNull()
  })

  it('pages through a section with more threads than one call returns', async () => {
    const bb = new FakeBb({ threads: Array.from({ length: 7 }, (_, i) => [`atlas:p_${i}`, 'atlas'] as const) })
    const b = new BbSectionsBackend(bb, 3) // a page of three
    const docs = await b.create('atlas', 'Docs')
    for (let i = 0; i < 7; i++) await b.moveCard('atlas', `atlas:p_${i}`, docs.id)
    expect((await b.list('atlas'))[0].cardIds).toEqual(Array.from({ length: 7 }, (_, i) => `atlas:p_${i}`))
  })

  it('pages when the count is an exact multiple of the page (the next call returns nothing)', async () => {
    const bb = new FakeBb({ threads: Array.from({ length: 6 }, (_, i) => [`atlas:p_${i}`, 'atlas'] as const) })
    const b = new BbSectionsBackend(bb, 3)
    const docs = await b.create('atlas', 'Docs')
    for (let i = 0; i < 6; i++) await b.moveCard('atlas', `atlas:p_${i}`, docs.id)
    expect((await b.list('atlas'))[0].cardIds).toHaveLength(6)
  })
})
