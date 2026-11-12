import { expect, it } from 'vitest'
import { InspectorEdits } from '../src/inspector-edits'
import { InspectorLiveApi } from '../src/inspector-live'
import { MemoryLineageStore } from '../src/lineage/store'
import { MemorySectionsBackend } from '../src/sections/memory-backend'
import { fromSidebar, type SidebarStateLike } from '../src/from-sidebar'
import { buildOutline } from '../src/selection'
import { creatureKey } from '../../desktop/src/scene'

it('resyncs the scene on a lineage-only edit and changes its geometry cache key', async () => {
  const edits = new InspectorEdits(new MemorySectionsBackend(), new MemoryLineageStore())
  const api = new InspectorLiveApi(edits)
  api.update({ now: 0, projects: [{ id: 'p', name: 'Alpha' }], sections: [], threads: [{ id: 't', projectId: 'p', title: 'Task', sectionId: null, provider: 'x', status: 'idle', needsHuman: false, unread: false, archived: false, hidden: false, updatedAt: 0 }] })
  const before = await api.snapshot()
  await edits.saveCreature('p', { lineage: { name: 'Phoenix' } })
  const after = await api.snapshot()
  expect(after.projects[0].lineage).toEqual({ name: 'Phoenix' })
  expect((await api.events(before.cursor, before.epoch)).resync).toBe(true)
  expect(creatureKey(before.projects[0])).not.toBe(creatureKey(after.projects[0]))
})

it('projects backend reads into both the board and outline before a sidebar refresh', async () => {
  const sections = new MemorySectionsBackend(), edits = new InspectorEdits(sections, new MemoryLineageStore())
  const s = await sections.create('p', 'Docs'); await sections.moveCard('p', 't', s.id)
  await edits.saveCreature('p', { name: 'Moss' })
  const sidebar: SidebarStateLike = { projects: [{ id: 'p', name: 'Alpha' }], sections: [], threads: [{ id: 't', projectId: 'p', displayTitle: 'Task', sectionId: null, providerId: 'x', status: 'idle', hasPendingInteraction: false, isUnread: false, isArchived: false, isHidden: false, updatedAt: 0 }] }
  const projected = edits.sidebar(sidebar)
  expect(buildOutline(projected)[0]).toMatchObject({ name: 'Moss', limbs: [{ name: 'Docs', sectionId: s.id }] })
  const api = new InspectorLiveApi(edits); api.update(fromSidebar(projected, 0))
  expect((await api.snapshot()).projects[0]).toMatchObject({ name: 'Moss', epics: [{ title: 'Docs' }] })
  expect(sidebar.threads[0].sectionId).toBeNull()
})
