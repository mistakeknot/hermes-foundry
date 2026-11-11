import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileLineageStore } from '../src/lineage/file-store'
import { MemoryLineageStore } from '../src/lineage/store'
import { InspectorEdits } from '../src/inspector-edits'
import { MemorySectionsBackend } from '../src/sections/memory-backend'
import { BbSectionsBackend } from '../src/sections/bb-backend'
import { FakeBb } from './sections/fake-bb'
import { pickLineage } from '../../desktop/src/creature'

it('recovers a missing file, serializes writes, and preserves corrupt data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foundry-lineage-'))
  const path = join(dir, 'lineages.json')
  try {
    const store = new FileLineageStore(path)
    expect(await store.get('p')).toEqual({})
    await Promise.all([store.set('p', { name: 'Moss' }), store.set('q', { lineage: { reroll: 2 } })])
    expect(await new FileLineageStore(path).get('p')).toEqual({ name: 'Moss' })
    expect(await store.get('q')).toEqual({ lineage: { reroll: 2 } })
    await Promise.all([store.set('p', { name: 'Fern' }), store.set('p', { lineage: { name: 'Phoenix' } })])
    expect(await store.get('p')).toEqual({ name: 'Fern', lineage: { name: 'Phoenix' } })
    await writeFile(path, '{bad')
    await expect(store.set('p', {})).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('{bad')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('publishes partial bb writes after a failed member move and keeps the write queue usable', async () => {
  const sdk = new FakeBb({ threads: [['a', 'p'], ['b', 'p']] })
  const sections = new BbSectionsBackend(sdk), edits = new InspectorEdits(sections, new MemoryLineageStore())
  const s = await sections.create('p', 'Docs')
  sdk.failNext.set('threads.update', new Error('Offline'))
  await expect(edits.saveSection('p', s.id, 'Plans', ['a'])).rejects.toThrow('Offline')
  expect(edits.project('p').sections[0]).toMatchObject({ name: 'Plans', cardIds: [] })
  await edits.saveSection('p', s.id, 'Plans', ['a'])
  expect(edits.project('p').sections[0].cardIds).toEqual(['a'])
})

for (const kind of ['memory', 'bb'] as const) describe(`${kind} inspector writes`, () => {
  const setup = () => {
    const sdk = new FakeBb({ threads: [['a', 'p'], ['b', 'p']] })
    const sections = kind === 'bb' ? new BbSectionsBackend(sdk) : new MemorySectionsBackend()
    return { sections, edits: new InspectorEdits(sections, new MemoryLineageStore()) }
  }
  it('renames and replaces members, moves removed members to Unsorted, publishes committed state', async () => {
    const { sections, edits } = setup()
    const limb = await sections.create('p', 'Docs')
    await sections.moveCard('p', 'a', limb.id)
    await edits.refresh('p')
    let notifications = 0
    edits.subscribe(() => notifications++)
    await edits.saveSection('p', limb.id, 'Plans', ['b'])
    expect(edits.project('p').sections).toEqual([{ ...limb, name: 'Plans', cardIds: ['b'] }])
    expect(await sections.list('p')).toEqual(edits.project('p').sections)
    expect(notifications).toBeGreaterThan(0)
  })
  it('leaves members untouched on duplicate name and recovers for later writes', async () => {
    const { sections, edits } = setup()
    const limb = await sections.create('p', 'Docs')
    await sections.create('p', 'Plans')
    await expect(edits.saveSection('p', limb.id, 'plans', ['a'])).rejects.toMatchObject({ code: 'duplicate_name' })
    expect((await sections.list('p'))[0].cardIds).toEqual([])
    await edits.saveSection('p', limb.id, 'Notes', ['a'])
    expect(edits.project('p').sections[0].cardIds).toEqual(['a'])
  })
  it('persists name, explicit lineage, reroll from current pick, and seeded reset', async () => {
    const { edits } = setup()
    await edits.saveCreature('p', { name: ' Moss ', lineage: { name: 'Phoenix' } })
    expect(edits.project('p').creature.name).toBe('Moss')
    await edits.reroll('p')
    expect(pickLineage('p', edits.project('p').creature.lineage)?.name).not.toBe('Phoenix')
    await edits.saveCreature('p', { lineage: {} })
    expect(edits.project('p').creature).toEqual({ name: 'Moss', lineage: {} })
    await expect(edits.saveCreature('p', { lineage: { name: 'missing' } })).rejects.toThrow()
    await expect(edits.saveCreature('p', { name: ' ' })).rejects.toThrow()
  })
})
