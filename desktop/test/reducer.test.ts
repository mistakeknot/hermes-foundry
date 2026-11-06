import { describe, expect, it } from 'vitest'
import { applyEvent, applyReply, applySnapshot, findCard } from '../src/reducer'
import { MockApi, buildFixture, statusOf } from '../src/mock'
import type { Card, EventsReply, FoundryEvent } from '../src/types'

const ev = (seq: number, type: FoundryEvent['type'], payload: unknown) => ({ seq, ts: '2026-11-07T00:00:00Z', type, payload }) as FoundryEvent
const reply = (epoch: string, cursor: string, events: FoundryEvent[], resync = false): EventsReply => ({ v: 1, epoch, cursor, events, resync })

describe('reducer', () => {
  const base = () => applySnapshot(buildFixture())
  const card = (): Card => structuredClone(findCard(buildFixture(), 'main:t1')!)

  it('derives worker card_id from claimed_by', () => {
    const s = buildFixture()
    s.workers[0].card_id = 'main:bogus' // an informational value that disagrees
    const st = applySnapshot(s)
    const held = st.snap.projects.flatMap((p) => p.cards).find((c) => c.claimed_by === 'fx:1')
    expect(st.snap.workers[0].card_id).toBe(held?.id ?? null)
  })
  it('card_upsert creates and changes; recomputes the worker', () => {
    let st = base()
    const c = card()
    c.claimed_by = 'fx:4'; c.status = 'running'; c.status_native = 'running'
    st = applyEvent(st, ev(1, 'card_upsert', { card: c }))!
    expect(findCard(st.snap, 'main:t1')?.claimed_by).toBe('fx:4')
    expect(st.snap.workers.find((w) => w.id === 'fx:4')?.card_id).toBe('main:t1')
    const fresh = { ...card(), id: 'main:t999' }
    st = applyEvent(st, ev(2, 'card_upsert', { card: fresh }))!
    expect(findCard(st.snap, 'main:t999')).toBeTruthy()
  })
  it('two cards for one worker: latest updated_at wins, ties go to the greatest id; others keep claimed_by', () => {
    const s = buildFixture()
    const [a, b] = [s.projects[0].cards[0], s.projects[0].cards[1]]
    for (const c of s.projects[0].cards) if (c.claimed_by === 'fx:4') c.claimed_by = null
    a.claimed_by = 'fx:4'; b.claimed_by = 'fx:4'
    a.updated_at = '2026-11-07T10:00:00Z'; b.updated_at = '2026-11-07T09:00:00Z'
    let st = applySnapshot(s)
    expect(st.snap.workers.find((w) => w.id === 'fx:4')?.card_id).toBe(a.id)
    expect(findCard(st.snap, b.id)?.claimed_by).toBe('fx:4')
    b.updated_at = a.updated_at
    st = applySnapshot(s)
    expect(st.snap.workers.find((w) => w.id === 'fx:4')?.card_id).toBe([a.id, b.id].sort().at(-1))
  })
  it('a claim naming a missing worker leaves every worker card_id untouched and does not throw', () => {
    const s = buildFixture()
    s.projects[0].cards[0].claimed_by = 'ghost'
    const st = applySnapshot(s)
    expect(st.snap.workers.some((w) => w.card_id === s.projects[0].cards[0].id)).toBe(false)
    expect(findCard(st.snap, s.projects[0].cards[0].id)?.claimed_by).toBe('ghost')
  })
  it('worker_removed clears claimed_by on every card that names it', () => {
    let st = base()
    const held = st.snap.projects.flatMap((p) => p.cards).filter((c) => c.claimed_by === 'fx:1')
    expect(held.length).toBeGreaterThan(0)
    st = applyEvent(st, ev(1, 'worker_removed', { worker_id: 'fx:1' }))!
    expect(st.snap.workers.some((w) => w.id === 'fx:1')).toBe(false)
    expect(st.snap.projects.flatMap((p) => p.cards).some((c) => c.claimed_by === 'fx:1')).toBe(false)
    expect(applyEvent(st, ev(2, 'worker_removed', { worker_id: 'fx:1' }))).not.toBeNull() // idempotent
  })
  it('card_upsert for an unknown board asks for a resync', () => {
    expect(applyEvent(base(), ev(1, 'card_upsert', { card: { ...card(), id: 'nope:t1' } }))).toBeNull()
  })
  it('card_removed removes; an unknown card asks for a resync', () => {
    let st = applyEvent(base(), ev(1, 'card_removed', { card_id: 'main:t1' }))!
    expect(findCard(st.snap, 'main:t1')).toBeUndefined()
    expect(applyEvent(st, ev(2, 'card_removed', { card_id: 'main:t1' }))).toBeNull()
  })
  it('worker_upsert / worker_removed / paused', () => {
    let st = applyEvent(base(), ev(1, 'worker_upsert', { worker: { id: 'fx:9', name: 'New', state: 'unknown', card_id: null } }))!
    expect(st.snap.workers.find((w) => w.id === 'fx:9')?.state).toBe('unknown')
    st = applyEvent(st, ev(2, 'worker_removed', { worker_id: 'fx:9' }))!
    expect(st.snap.workers.find((w) => w.id === 'fx:9')).toBeUndefined()
    st = applyEvent(st, ev(3, 'paused', { paused: true }))!
    expect(st.snap.paused).toBe(true)
  })
  it('comments are kept outside the snapshot', () => {
    const st = applyEvent(base(), ev(1, 'comment_added', { card_id: 'main:t1', author: 'ada', text: 'hi' }))!
    expect(st.comments).toHaveLength(1)
  })
  it('ignores duplicates and replays (seq <= watermark) and does not mutate input', () => {
    const st0 = base()
    const frozen = JSON.stringify(st0)
    const e = ev(1, 'paused', { paused: true })
    const r1 = applyReply(st0, reply('fx1', 'fx1.1', [e, e]))
    expect(r1.state.snap.paused).toBe(true)
    expect(JSON.stringify(st0)).toBe(frozen)
    const r2 = applyReply(r1.state, reply('fx1', 'fx1.1', [ev(1, 'paused', { paused: false })]))
    expect(r2.state.snap.paused).toBe(true) // replay ignored
  })
  it('applies out-of-order events in seq order', () => {
    const r = applyReply(base(), reply('fx1', 'fx1.3', [ev(3, 'paused', { paused: false }), ev(2, 'paused', { paused: true })]))
    expect(r.state.snap.paused).toBe(false)
    expect(r.state.watermark).toBe(3)
  })
  it('tolerates non-contiguous seq (no gap detection)', () => {
    const r = applyReply(base(), reply('fx1', 'fx1.40', [ev(7, 'paused', { paused: true }), ev(40, 'paused', { paused: false })]))
    expect(r.resync).toBe(false)
    expect(r.state.watermark).toBe(40)
  })
  it('epoch change or resync:true asks for a refetch and leaves state alone', () => {
    const st = base()
    expect(applyReply(st, reply('fx2', 'fx2.0', [])).resync).toBe(true)
    expect(applyReply(st, reply('fx1', 'fx1.0', [], true)).resync).toBe(true)
  })
  it('an event it cannot resolve resyncs instead of guessing', () => {
    const r = applyReply(base(), reply('fx1', 'fx1.1', [ev(1, 'card_removed', { card_id: 'main:ghost' })]))
    expect(r.resync).toBe(true)
  })
  it('stores the cursor from the reply unchanged', () => {
    const r = applyReply(base(), reply('fx1', 'opaque-☃', []))
    expect(r.state.cursor).toBe('opaque-☃')
  })
  it('an unknown native status draws as unknown, not guessed', () => {
    expect(statusOf('triage')).toBe('open')
    expect(statusOf('on-fire')).toBe('unknown')
  })
})

describe('mock adapter', () => {
  const make = () => { let t = 0; const api = new MockApi(() => t, 1000); return { api, tick: (ms: number) => { t += ms } } }

  it('snapshot: 3 projects, ~40 cards, 4 workers, a loop, a card blocked on a human', async () => {
    const { api } = make()
    const s = await api.snapshot()
    expect(s.projects).toHaveLength(3)
    expect(s.projects.reduce((n, p) => n + p.cards.length, 0)).toBe(40)
    expect(s.workers).toHaveLength(4)
    expect(s.workers.some((w) => w.state === 'looping')).toBe(true)
    expect(s.projects.flatMap((p) => p.cards).some((c) => c.blocked_on === 'human')).toBe(true)
    expect(s.mode).toBe('fixture')
    expect(api.simulated).toBe(true)
  })
  it('ownership invariant holds in the fixture', async () => {
    const s = applySnapshot(await make().api.snapshot()).snap
    for (const w of s.workers) {
      const held = s.projects.flatMap((p) => p.cards).find((c) => c.claimed_by === w.id)
      expect(w.card_id).toBe(held?.id ?? null)
    }
  })
  it('a command shows up in the event stream and the reducer reaches the same state as a fresh snapshot', async () => {
    const { api } = make()
    let st = applySnapshot(await api.snapshot())
    expect(await api.command({ type: 'set_status', card_id: 'main:t1', status_native: 'review' })).toEqual({ ok: true })
    expect(await api.command({ type: 'assign', card_id: 'main:t2', profile: 'coder' })).toEqual({ ok: true })
    const rep = await api.events(st.cursor, st.epoch)
    const r = applyReply(st, rep)
    expect(r.resync).toBe(false)
    const fresh = applySnapshot(await api.snapshot())
    expect(r.state.snap.projects).toEqual(fresh.snap.projects)
    expect(r.state.snap.workers).toEqual(fresh.snap.workers)
    expect(r.state.watermark).toBe(fresh.watermark)
    st = r.state
    expect(findCard(st.snap, 'main:t1')?.status).toBe('review')
  })
  it('assign sets the profile and does not claim', async () => {
    const { api } = make()
    const before = findCard(applySnapshot(await api.snapshot()).snap, 'main:t2')!
    await api.command({ type: 'assign', card_id: 'main:t2', profile: 'reviewer' })
    const after = findCard(applySnapshot(await api.snapshot()).snap, 'main:t2')!
    expect(after.assignee_profile).toBe('reviewer')
    expect(after.claimed_by).toBe(before.claimed_by)
  })
  it('a failed command changes nothing and returns the error', async () => {
    const { api } = make()
    const before = JSON.stringify(await api.snapshot())
    const r1 = await api.command({ type: 'set_status', card_id: 'main:nope', status_native: 'done' })
    const r2 = await api.command({ type: 'assign', card_id: 'main:t1', profile: 'nobody' })
    const r3 = await api.command({ type: 'new_worker', card_id: 'main:t1' })
    expect([r1.ok, r2.ok, r3.ok]).toEqual([false, false, false])
    expect(r1.error).toBeTruthy()
    expect(JSON.stringify(await api.snapshot())).toBe(before)
  })
  it('the scripted story moves workers over time; reset changes the epoch and forces a resync', async () => {
    const { api, tick } = make()
    const st = applySnapshot(await api.snapshot())
    tick(1500)
    const rep = await api.events(st.cursor, st.epoch)
    expect(rep.events.length).toBeGreaterThan(0)
    await api.command({ type: 'reset' })
    const after = await api.events(rep.cursor, rep.epoch)
    expect(after.resync).toBe(true)
    expect(after.epoch).not.toBe(rep.epoch)
    expect(applyReply(st, after).resync).toBe(true)
  })
  it('a stale cursor from another epoch is answered with resync, not events', async () => {
    const { api } = make()
    expect((await api.events('zz.5', 'zz')).resync).toBe(true)
  })
})
