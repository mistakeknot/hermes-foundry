import { describe, expect, it } from 'vitest'
import { LiveApi, READ_ONLY_ERROR, buildLiveShape, mapStatus, restFromApi, type LiveInput, type LiveThread } from '../src/live'
import { applyEvent, applyReply, applySnapshot } from '../src/reducer'

const NOW = Date.parse('2026-11-06T12:00:00Z')
const H = 3600_000
const th = (id: string, over: Partial<LiveThread> = {}): LiveThread => ({
  id, projectId: 'p1', title: `Thread ${id}`, sectionId: null, provider: 'claude', status: 'idle', needsHuman: false,
  unread: false, archived: false, hidden: false, updatedAt: NOW - H, ...over,
})
const input = (threads: LiveThread[], over: Partial<LiveInput> = {}): LiveInput => ({
  projects: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }], sections: [{ id: 's1', name: 'Section' }], threads, now: NOW, ...over,
})

describe('mapStatus', () => {
  const day = 24 * H
  it('reads a thread into the card statuses', () => {
    expect(mapStatus(th('a', { status: 'active' }), NOW, day).status).toBe('running')
    expect(mapStatus(th('a', { status: 'starting' }), NOW, day).status).toBe('running')
    expect(mapStatus(th('a', { needsHuman: true, status: 'active' }), NOW, day)).toMatchObject({ status: 'blocked', blockedOn: 'human' })
    expect(mapStatus(th('a', { status: 'error' }), NOW, day)).toMatchObject({ status: 'blocked', native: 'error', blockedOn: null })
    expect(mapStatus(th('a', { unread: true }), NOW, day).status).toBe('review')
    expect(mapStatus(th('a'), NOW, day).status).toBe('open')
    expect(mapStatus(th('a', { updatedAt: NOW - 3 * day }), NOW, day).status).toBe('done')
  })
})

describe('buildLiveShape', () => {
  it('maps projects to boards, sections to epics, running threads to workers', () => {
    const s = buildLiveShape(input([
      th('a', { status: 'active', sectionId: 's1' }),
      th('b', { needsHuman: true }),
      th('c', { projectId: 'p2' }),
    ]))
    expect(s.mode).toBe('live')
    expect(s.projects.map((p) => p.id)).toEqual(['p1', 'p2'])
    const p1 = s.projects[0]
    expect(p1.epics).toEqual([{ id: 's1', title: 'Section' }])
    expect(p1.cards.map((c) => c.id)).toEqual(['p1:a', 'p1:b'])
    expect(p1.cards[0]).toMatchObject({ epic_id: 's1', claimed_by: 'a', status: 'running', assignee_profile: 'claude' })
    expect(s.workers).toEqual([
      { id: 'a', name: 'Thread a', state: 'working', card_id: 'p1:a' },
      { id: 'b', name: 'Thread b', state: 'waiting_human', card_id: 'p1:b' },
    ])
    expect(s.projects[1].cards[0].claimed_by).toBeNull()
  })

  it('drops archived, hidden, unknown-project threads and empty projects', () => {
    const s = buildLiveShape(input([
      th('a', { archived: true }), th('b', { hidden: true }), th('c', { projectId: 'nope' }), th('d', { projectId: 'p2' }),
    ]))
    expect(s.projects.map((p) => p.id)).toEqual(['p2'])
  })

  it('ignores an unknown section and emits ISO times with an offset', () => {
    const s = buildLiveShape(input([th('a', { sectionId: 'gone' })]))
    expect(s.projects[0].cards[0].epic_id).toBeNull()
    expect(s.projects[0].cards[0].updated_at).toMatch(/Z$/)
  })

  it('caps the cards but always keeps working and waiting threads', () => {
    const many = Array.from({ length: 50 }, (_, i) => th(`i${String(i).padStart(2, '0')}`, { updatedAt: NOW - i * 1000 }))
    const s = buildLiveShape(input([...many, th('run', { status: 'active', updatedAt: NOW - 99 * H }), th('ask', { needsHuman: true, updatedAt: NOW - 98 * H })]), { maxCards: 5 })
    const ids = s.projects[0].cards.map((c) => c.id)
    expect(ids).toHaveLength(5)
    expect(ids).toContain('p1:run')
    expect(ids).toContain('p1:ask')
  })

  it('card ids split to their project, and the reducer takes the snapshot', () => {
    const live = new LiveApi({}, () => NOW, 't')
    live.update(input([th('a', { status: 'active' })]))
    return live.snapshot().then((snap) => {
      const st = applySnapshot(snap)
      expect(st.snap.workers[0].card_id).toBe('p1:a')
    })
  })
})

describe('LiveApi', () => {
  const mk = () => new LiveApi({}, () => NOW, 'tag')

  it('has no snapshot before data and is not simulated', async () => {
    const api = mk()
    expect(api.simulated).toBe(false)
    await expect(api.snapshot()).rejects.toThrow()
  })

  it('diffs updates into events the reducer applies to the same board', async () => {
    const api = mk()
    api.update(input([th('a', { status: 'active' }), th('b')]))
    const snap = await api.snapshot()
    let st = applySnapshot(snap)
    api.update(input([th('a', { status: 'idle', unread: true }), th('c', { status: 'active' })]))
    const r = await api.events(snap.cursor, snap.epoch)
    expect(r.resync).toBe(false)
    expect(r.events.map((e) => e.type).sort()).toEqual(['card_removed', 'card_upsert', 'card_upsert', 'worker_removed', 'worker_upsert'])
    for (const e of r.events) {
      const next = applyEvent(st, e)
      expect(next).not.toBeNull() // null would mean the reducer wants a resync
      st = next!
    }
    const fresh = applySnapshot(await api.snapshot())
    const flat = (s: typeof st) => s.snap.projects.flatMap((p) => p.cards).map((c) => [c.id, c.status, c.claimed_by]).sort()
    expect(flat(st)).toEqual(flat(fresh))
    expect(st.snap.workers.map((w) => [w.id, w.card_id])).toEqual(fresh.snap.workers.map((w) => [w.id, w.card_id]))
  })

  it('emits nothing for an unchanged input', async () => {
    const api = mk()
    api.update(input([th('a')]))
    const snap = await api.snapshot()
    api.update(input([th('a')]))
    expect((await api.events(snap.cursor, snap.epoch)).events).toEqual([])
  })

  it('asks for a resync on a stale epoch or cursor and bumps the epoch when the structure changes', async () => {
    const api = mk()
    api.update(input([th('a')]))
    const snap = await api.snapshot()
    expect((await api.events(snap.cursor, 'other')).resync).toBe(true)
    expect((await api.events('999', snap.epoch)).resync).toBe(true)
    expect((await api.events('x', snap.epoch)).resync).toBe(true)
    api.update(input([th('a'), th('z', { projectId: 'p2' })]))
    const r = await api.events(snap.cursor, snap.epoch)
    expect(r.resync).toBe(true)
    expect(r.epoch).not.toBe(snap.epoch)
    expect((await api.snapshot()).projects.map((p) => p.id)).toEqual(['p1', 'p2'])
  })

  it.each([1001, 1250, 2250])('retains the latest 1000 events after %i updates and replays from the base cursor', async (total) => {
    const api = mk()
    api.update(input([th('a')]))
    const base = total - 1000
    // An idle thread's title change emits exactly one card_upsert, with no worker or structure changes.
    for (let seq = 1; seq <= base; seq++) api.update(input([th('a', { title: `Revision ${seq}` })]))
    const baseSnap = await api.snapshot()
    expect(baseSnap.cursor).toBe(String(base))
    for (let seq = base + 1; seq <= total; seq++) api.update(input([th('a', { title: `Revision ${seq}` })]))

    const fresh = await api.snapshot()
    expect(fresh).toMatchObject({ epoch: baseSnap.epoch, cursor: String(total), last_seq: total })
    const replay = await api.events(baseSnap.cursor, baseSnap.epoch)
    expect(replay).toMatchObject({ resync: false, epoch: baseSnap.epoch, cursor: String(total) })
    expect(replay.events).toHaveLength(1000)
    expect(replay.events.map((e) => e.seq)).toEqual(Array.from({ length: 1000 }, (_, i) => base + i + 1))
    for (const e of replay.events) {
      expect(e).toMatchObject({ type: 'card_upsert', payload: { card: { id: 'p1:a', title: `Revision ${e.seq}` } } })
    }
    const applied = applyReply(applySnapshot(baseSnap), replay)
    expect(applied.resync).toBe(false)
    expect(applied.state.watermark).toBe(total)
    expect(applied.state.cursor).toBe(fresh.cursor)
    expect(applied.state.snap.projects).toEqual(fresh.projects)
    expect(applied.state.snap.workers).toEqual(fresh.workers)

    expect(await api.events(String(base - 1), baseSnap.epoch)).toEqual({
      v: 1, epoch: fresh.epoch, cursor: fresh.cursor, events: [], resync: true,
    })
    expect(await api.events(fresh.cursor, fresh.epoch)).toEqual({
      v: 1, epoch: fresh.epoch, cursor: fresh.cursor, events: [], resync: false,
    })
  })

  it('is read-only', async () => {
    expect(await mk().command({ type: 'reset' })).toEqual({ ok: false, error: READ_ONLY_ERROR })
  })
})

describe('restFromApi', () => {
  it('serves the contract paths and 404s the rest', async () => {
    const api = new LiveApi({}, () => NOW, 'tag')
    let cur: LiveApi | null = null
    const rest = restFromApi(() => cur)
    await expect(rest('/snapshot')).rejects.toThrow(/404/)
    cur = api
    api.update(input([th('a')]))
    const snap = await rest<{ v: number; cursor: string; epoch: string }>('/snapshot')
    expect(snap.v).toBe(1)
    const ev = await rest<{ resync: boolean }>(`/events?since=${snap.cursor}&epoch=${snap.epoch}`)
    expect(ev.resync).toBe(false)
    expect(await rest('/command', { method: 'POST', body: { type: 'reset' } })).toMatchObject({ ok: false })
    await expect(rest('/transcript?worker_id=a')).rejects.toThrow(/404/)
  })
})
