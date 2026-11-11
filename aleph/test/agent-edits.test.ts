import { expect, it } from 'vitest'
import { InspectorEdits } from '../src/inspector-edits'
import { AgentEdits, operations } from '../src/agent-edits'
import { MemorySectionsBackend } from '../src/sections/memory-backend'
import { MemoryLineageStore } from '../src/lineage/store'

async function setup() {
  const sections = new MemorySectionsBackend()
  const a = await sections.create('p', 'Docs'), b = await sections.create('p', 'Plans')
  const edits = new InspectorEdits(sections, new MemoryLineageStore())
  const agent = new AgentEdits(edits, () => ({ projects: [{ id: 'p' }], threads: [{ id: 't', projectId: 'p' }] }))
  await edits.refresh('p')
  return { edits, agent, a, b }
}
it('advertises a small operation set and rejects extra fields, bad types and unknown ids without writes', async () => {
  const { edits, agent, a } = await setup()
  expect(operations.map(x => x.name)).toEqual(['rename_section', 'move_thread', 'pick_lineage', 'reroll_lineage', 'undo_edit'])
  const before = edits.project('p')
  for (const call of [null, { name: 'other', arguments: {} }, { name: 'reroll_lineage', arguments: { projectId: 'p', extra: 1 } }, { name: 'move_thread', arguments: { projectId: 'p', threadId: 1, sectionId: a.id } }]) {
    expect(await agent.dispatch(call)).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  }
  for (const call of [
    { name: 'reroll_lineage', arguments: { projectId: 'missing' } },
    { name: 'move_thread', arguments: { projectId: 'p', threadId: 'missing', sectionId: null } },
    { name: 'rename_section', arguments: { projectId: 'p', sectionId: 'missing', name: 'Next' } },
  ]) expect(await agent.dispatch(call)).toMatchObject({ ok: false, error: { code: 'not_found' } })
  expect(await agent.dispatch({ name: 'rename_section', arguments: { projectId: 'p', sectionId: a.id, name: 'plans' } })).toMatchObject({ ok: false, error: { code: 'duplicate_name' } })
  expect(await agent.dispatch({ name: 'pick_lineage', arguments: { projectId: 'p', name: 'missing' } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  expect(edits.project('p')).toEqual(before)
  expect(edits.history()).toEqual([])
})
it('shares committed state and history with forms, and restores previous values with undo', async () => {
  const { edits, agent, a, b } = await setup()
  let redraws = 0
  edits.subscribe(() => redraws++)
  expect(await agent.dispatch({ name: 'rename_section', arguments: { projectId: 'p', sectionId: a.id, name: 'Notes' } })).toMatchObject({ ok: true })
  await edits.saveSection('p', a.id, 'Forms', ['t'])
  expect(edits.project('p').sections[0]).toMatchObject({ name: 'Forms', cardIds: ['t'] })
  expect(edits.history().map(x => x.summary)).toEqual(['Section: Notes', 'Section: Forms (1 members)'])
  const moved = await agent.dispatch({ name: 'move_thread', arguments: { projectId: 'p', threadId: 't', sectionId: b.id } })
  expect(moved.ok).toBe(true)
  if (!moved.ok) return
  expect(edits.project('p').sections[1].cardIds).toEqual(['t'])
  expect(await agent.dispatch({ name: 'undo_edit', arguments: { editId: moved.editId } })).toMatchObject({ ok: true })
  expect(edits.project('p').sections[0].cardIds).toEqual(['t'])
  expect(await agent.dispatch({ name: 'undo_edit', arguments: { editId: moved.editId } })).toMatchObject({ ok: false, error: { code: 'not_found' } })
  expect(redraws).toBeGreaterThan(3)
})
it('undoes lineage picks and rerolls to the previously committed selection, preserving form name edits', async () => {
  const { edits, agent } = await setup()
  for (const call of [
    { name: 'pick_lineage', arguments: { projectId: 'p', name: 'Phoenix' } },
    { name: 'reroll_lineage', arguments: { projectId: 'p' } },
  ]) {
    const before = edits.project('p').creature.lineage ?? {}
    const result = await agent.dispatch(call)
    expect(result.ok).toBe(true)
    await edits.saveCreature('p', { name: 'Moss' })
    if (result.ok) expect(await agent.dispatch({ name: 'undo_edit', arguments: { editId: result.editId } })).toMatchObject({ ok: true })
    expect(edits.project('p').creature).toEqual({ name: 'Moss', lineage: before })
  }
})
it('does not undo over a newer form edit on the same field', async () => {
  const { edits, agent, a } = await setup()
  const result = await agent.dispatch({ name: 'rename_section', arguments: { projectId: 'p', sectionId: a.id, name: 'Notes' } })
  await edits.saveSection('p', a.id, 'Later', [])
  if (result.ok) expect(await agent.dispatch({ name: 'undo_edit', arguments: { editId: result.editId } })).toMatchObject({ ok: false, error: { code: 'conflict' } })
  expect(edits.project('p').sections[0].name).toBe('Later')
})
it('validates names and project ids before any backend writes', async () => {
  const { edits, agent, a } = await setup()
  for (const name of ['', 'Unsorted', 'x'.repeat(81), '\u0000bad']) {
    expect(await agent.dispatch({ name: 'rename_section', arguments: { projectId: 'p', sectionId: a.id, name } })).toMatchObject({ ok: false, error: { code: 'invalid_name' } })
  }
  expect(await agent.dispatch({ name: 'reroll_lineage', arguments: { projectId: '../bad' } })).toMatchObject({ ok: false, error: { code: 'invalid_id' } })
  expect(edits.history()).toHaveLength(0)
})
it('serializes a form edit with an agent edit and keeps history and results defensive', async () => {
  const { edits, agent, a } = await setup()
  const [, result] = await Promise.all([
    edits.saveSection('p', a.id, 'Form first', ['t']),
    agent.dispatch({ name: 'rename_section', arguments: { projectId: 'p', sectionId: a.id, name: 'Agent next' } }),
  ])
  expect(result.ok).toBe(true)
  expect(edits.project('p').sections[0]).toMatchObject({ name: 'Agent next', cardIds: ['t'] })
  const history = edits.history()
  history[0].summary = 'mutated'
  expect(edits.history()[0].summary).not.toBe('mutated')
  if (result.ok) result.state.sections[0].name = 'mutated'
  expect(edits.project('p').sections[0].name).toBe('Agent next')
})
it('undoes a move from Unsorted and retries undo after a duplicate name is resolved', async () => {
  const { edits, agent, a } = await setup()
  const move = await agent.dispatch({ name: 'move_thread', arguments: { projectId: 'p', threadId: 't', sectionId: a.id } })
  if (!move.ok) throw new Error('Move failed')
  expect(await agent.dispatch({ name: 'undo_edit', arguments: { editId: move.editId } })).toMatchObject({ ok: true })
  expect(edits.project('p').sections[0].cardIds).toEqual([])
  const rename = await agent.dispatch({ name: 'rename_section', arguments: { projectId: 'p', sectionId: a.id, name: 'Notes' } })
  if (!rename.ok) throw new Error('Rename failed')
  const other = edits.project('p').sections[1]
  await edits.saveSection('p', other.id, 'Docs', [])
  expect(await agent.dispatch({ name: 'undo_edit', arguments: { editId: rename.editId } })).toMatchObject({ ok: false, error: { code: 'duplicate_name' } })
  await edits.saveSection('p', other.id, 'Other', [])
  expect(await agent.dispatch({ name: 'undo_edit', arguments: { editId: rename.editId } })).toMatchObject({ ok: true })
  expect(edits.project('p').sections[0].name).toBe('Docs')
})
it('rejects undo after a form renames away and back to the same section name', async () => {
  const { edits, agent, a } = await setup()
  const renamed = await agent.dispatch({ name: 'rename_section', arguments: { projectId: 'p', sectionId: a.id, name: 'Notes' } })
  if (!renamed.ok) throw new Error('Rename failed')
  await edits.saveSection('p', a.id, 'Later', [])
  await edits.saveSection('p', a.id, 'Notes', [])
  expect(await agent.dispatch({ name: 'undo_edit', arguments: { editId: renamed.editId } })).toMatchObject({ ok: false, error: { code: 'conflict' } })
  expect(edits.project('p').sections[0].name).toBe('Notes')
})
it('rejects lineage undo after form changes away and back to the same selection', async () => {
  const { edits, agent } = await setup()
  const picked = await agent.dispatch({ name: 'pick_lineage', arguments: { projectId: 'p', name: 'Phoenix' } })
  if (!picked.ok) throw new Error('Pick failed')
  await edits.saveCreature('p', { lineage: {} })
  await edits.saveCreature('p', { lineage: { name: 'Phoenix' } })
  expect(await agent.dispatch({ name: 'undo_edit', arguments: { editId: picked.editId } })).toMatchObject({ ok: false, error: { code: 'conflict' } })
  expect(edits.project('p').creature.lineage).toEqual({ name: 'Phoenix' })
})
for (const writer of ['form', 'move'] as const) it(`rejects membership undo after ${writer} moves away and back`, async () => {
  const { edits, agent, a, b } = await setup()
  const moved = await agent.dispatch({ name: 'move_thread', arguments: { projectId: 'p', threadId: 't', sectionId: a.id } })
  if (!moved.ok) throw new Error('Move failed')
  if (writer === 'form') {
    await edits.saveSection('p', b.id, 'Plans', ['t'])
    await edits.saveSection('p', a.id, 'Docs', ['t'])
  } else {
    await edits.moveCard('p', 't', b.id)
    await edits.moveCard('p', 't', a.id)
  }
  expect(await agent.dispatch({ name: 'undo_edit', arguments: { editId: moved.editId } })).toMatchObject({ ok: false, error: { code: 'conflict' } })
  expect(edits.project('p').sections[0].cardIds).toEqual(['t'])
})
