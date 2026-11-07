import { describe, expect, it } from 'vitest'
import { LiveApi } from '../../desktop/src/live'
import { fromSidebar, type SidebarStateLike } from '../src/from-sidebar'

const NOW = Date.parse('2026-11-06T12:00:00Z')
const state: SidebarStateLike = {
  projects: [{ id: 'p1', name: 'Alpha' }],
  sections: [{ id: 's1', name: 'Docs' }],
  threads: [
    { id: 't1', projectId: 'p1', displayTitle: 'Fix the build', sectionId: 's1', providerId: 'claude-code', status: 'active', hasPendingInteraction: false, isUnread: false, isArchived: false, isHidden: false, updatedAt: NOW - 1000 },
    { id: 't2', projectId: 'p1', displayTitle: 'Needs an answer', sectionId: null, providerId: 'codex', status: 'idle', hasPendingInteraction: true, isUnread: true, isArchived: false, isHidden: false, updatedAt: NOW - 5000 },
  ],
}

describe('fromSidebar', () => {
  it('renames the bb sidebar fields to the neutral live input', () => {
    const i = fromSidebar(state, NOW)
    expect(i.threads[1]).toMatchObject({ id: 't2', title: 'Needs an answer', provider: 'codex', needsHuman: true, unread: true })
    expect(i.projects).toEqual([{ id: 'p1', name: 'Alpha' }])
  })

  it('drives the board: working thread climbs, waiting thread is blocked on a human', async () => {
    const api = new LiveApi({}, () => NOW)
    api.update(fromSidebar(state, NOW))
    const snap = await api.snapshot()
    expect(snap.mode).toBe('live')
    expect(snap.projects[0].cards.map((c) => [c.id, c.status])).toEqual([['p1:t1', 'running'], ['p1:t2', 'blocked']])
    expect(snap.workers.map((w) => [w.id, w.state])).toEqual([['t1', 'working'], ['t2', 'waiting_human']])
  })
})
