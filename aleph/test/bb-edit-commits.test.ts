import { expect, it } from 'vitest'
import { AgentEdits } from '../src/agent-edits'
import { InspectorEdits } from '../src/inspector-edits'
import { MemoryLineageStore } from '../src/lineage/store'
import { BbSectionsBackend } from '../src/sections/bb-backend'
import { SectionsCommittedError } from '../src/sections/types'
import { FakeBb } from './sections/fake-bb'

async function setup(persistent = false) {
  const sdk = new FakeBb({ threads: [['t', 'p']] })
  const sections = new BbSectionsBackend(sdk)
  const section = await sections.create('p', 'Docs')
  const edits = new InspectorEdits(sections, new MemoryLineageStore())
  const agent = new AgentEdits(edits, () => ({ projects: [{ id: 'p' }], threads: [{ id: 't', projectId: 'p' }] }))
  await edits.refresh('p')
  // Fail the first membership read after each real bb acknowledgement, inside rename
  // or in the edit service's read-back for moves. Preflight reads still succeed.
  let blocked = false
  const list = sdk.threads.list
  sdk.threads.list = async args => {
    if (blocked) throw new Error('Membership read still unavailable')
    return list(args)
  }
  const failAfterAck = () => {
    if (persistent) blocked = true
    else sdk.failNext.set('threads.list', new Error('Membership read failed'))
  }
  const rename = sdk.threadSections.update, move = sdk.threads.update
  sdk.threadSections.update = async args => {
    const result = await rename(args)
    failAfterAck()
    return result
  }
  sdk.threads.update = async args => {
    const result = await move(args)
    failAfterAck()
    return result
  }
  return { sdk, sections, section, edits, agent, recover: () => { blocked = false } }
}
for (const kind of ['rename', 'move'] as const) it(`retains acknowledged bb ${kind} and undo despite post-commit read failures`, async () => {
  const { sdk, section, edits, agent } = await setup()
  const result = await agent.dispatch(kind === 'rename'
    ? { name: 'rename_section', arguments: { projectId: 'p', sectionId: section.id, name: 'Notes' } }
    : { name: 'move_thread', arguments: { projectId: 'p', threadId: 't', sectionId: section.id } })
  expect(result).toMatchObject({ ok: true, status: 'committed_refresh_failed' })
  if (!result.ok) throw new Error('Commit not reported')
  expect(edits.history()).toMatchObject([{ id: result.editId, undoable: true }])
  if (kind === 'rename') {
    expect(sdk.rawSections()[0].name).toBe('foundry/p/Notes')
    expect(edits.project('p').sections[0].name).toBe('Notes')
  } else expect(sdk.rawThread('t')?.sectionId).toBe(section.id)
  expect(await agent.dispatch({ name: 'undo_edit', arguments: { editId: result.editId } })).toMatchObject({ ok: true, status: 'committed_refresh_failed' })
  expect(edits.history()).toHaveLength(2)
  expect(edits.history()[0].undoable).toBe(false)
  expect(edits.history()[1].summary).toContain('Undid:')
  if (kind === 'rename') expect(sdk.rawSections()[0].name).toBe('foundry/p/Docs')
  else expect(sdk.rawThread('t')?.sectionId).toBeNull()
  expect(await agent.dispatch({ name: 'undo_edit', arguments: { editId: result.editId } })).toMatchObject({ ok: false, error: { code: 'not_found' } })
})
it('keeps form rename revisions and history across two acknowledged bb renames with failed membership reads', async () => {
  const { section, edits, agent } = await setup()
  const result = await agent.dispatch({ name: 'rename_section', arguments: { projectId: 'p', sectionId: section.id, name: 'Notes' } })
  if (!result.ok) throw new Error('Commit not reported')
  for (const name of ['Later', 'Notes']) {
    await expect(edits.saveSection('p', section.id, name, [])).rejects.toMatchObject({ name: 'CommittedRefreshError' })
  }
  expect(edits.history()).toHaveLength(3)
  expect(edits.project('p').sections[0].name).toBe('Notes')
  expect(await agent.dispatch({ name: 'undo_edit', arguments: { editId: result.editId } })).toMatchObject({ ok: false, error: { code: 'conflict' } })
})
it('preserves the acknowledged form rename if a later member write is rejected', async () => {
  const { sdk, section, edits } = await setup()
  sdk.failNext.set('threads.update', new Error('Move rejected'))
  await expect(edits.saveSection('p', section.id, 'Notes', ['t'])).rejects.toThrow('Move rejected')
  expect(sdk.rawSections()[0].name).toBe('foundry/p/Notes')
  expect(sdk.rawThread('t')?.sectionId).toBeNull()
  expect(edits.project('p').sections[0].name).toBe('Notes')
  expect(edits.history()).toHaveLength(1)
  expect(edits.history()[0]).toMatchObject({ undoable: false })
  expect(edits.history()[0].summary).toContain('partly saved')
})

it('carries an explicit move acknowledgement through agent edits, form saves and undo', async () => {
  class MoveReadFailure extends BbSectionsBackend {
    async moveCard(id: string, cardId: string, sectionId: string | null) {
      await super.moveCard(id, cardId, sectionId)
      throw new SectionsCommittedError({ kind: 'move', cardId, sectionId })
    }
  }
  const sdk = new FakeBb({ threads: [['t', 'p']] })
  const sections = new MoveReadFailure(sdk), section = await sections.create('p', 'Docs')
  const edits = new InspectorEdits(sections, new MemoryLineageStore())
  const agent = new AgentEdits(edits, () => ({ projects: [{ id: 'p' }], threads: [{ id: 't', projectId: 'p' }] }))
  const result = await agent.dispatch({ name: 'move_thread', arguments: { projectId: 'p', threadId: 't', sectionId: section.id } })
  expect(result).toMatchObject({ ok: true, status: 'committed_refresh_failed' })
  if (!result.ok) throw new Error('Commit not reported')
  expect(await agent.dispatch({ name: 'undo_edit', arguments: { editId: result.editId } })).toMatchObject({ ok: true, status: 'committed_refresh_failed' })
  expect(edits.history()[0].undoable).toBe(false)
  await expect(edits.saveSection('p', section.id, 'Plans', ['t'])).rejects.toMatchObject({ name: 'CommittedRefreshError' })
  expect(edits.project('p').sections[0]).toMatchObject({ name: 'Plans', cardIds: ['t'] })
  expect(edits.history()).toHaveLength(3)
})

for (const kind of ['rename', 'move'] as const) it(`retains bb ${kind} and consumes undo when both backend and service read-back remain unavailable`, async () => {
  const { sdk, section, edits, agent, recover } = await setup(true)
  const result = await agent.dispatch(kind === 'rename'
    ? { name: 'rename_section', arguments: { projectId: 'p', sectionId: section.id, name: 'Notes' } }
    : { name: 'move_thread', arguments: { projectId: 'p', threadId: 't', sectionId: section.id } })
  expect(result).toMatchObject({ ok: true, status: 'committed_refresh_failed' })
  if (!result.ok) throw new Error('Commit not reported')
  expect(edits.history()[0].undoable).toBe(true)
  if (kind === 'rename') expect(edits.project('p').sections[0].name).toBe('Notes')
  else expect(edits.project('p').sections[0].cardIds).toEqual(['t'])
  recover()
  expect(await agent.dispatch({ name: 'undo_edit', arguments: { editId: result.editId } })).toMatchObject({ ok: true, status: 'committed_refresh_failed' })
  expect(edits.history()).toHaveLength(2)
  expect(edits.history()[0].undoable).toBe(false)
  if (kind === 'rename') expect(sdk.rawSections()[0].name).toBe('foundry/p/Docs')
  else expect(sdk.rawThread('t')?.sectionId).toBeNull()
})
