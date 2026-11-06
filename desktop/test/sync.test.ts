import { describe, expect, it, vi } from 'vitest'
import { startSync } from '../src/sync'
import { MockApi } from '../src/mock'
import type { EventsReply, FoundryApi, PaneState } from '../src/types'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('sync loop', () => {
  it('fetches a snapshot then applies events', async () => {
    let t = 0
    const api = new MockApi(() => t, 10)
    const states: PaneState[] = []
    const h = startSync(api, { intervalMs: 5, onState: (s) => states.push(s) })
    await wait(30)
    t += 100
    await wait(40)
    h.stop()
    expect(states.length).toBeGreaterThan(1)
    expect(states.at(-1)!.watermark).toBeGreaterThan(states[0].watermark)
  })
  it('refetches the snapshot after an error and after resync:true', async () => {
    const real = new MockApi(() => 0)
    let n = 0
    const api: FoundryApi = {
      simulated: true,
      snapshot: vi.fn(() => real.snapshot()),
      events: vi.fn(async (c, e): Promise<EventsReply> => {
        n++
        if (n === 1) throw new Error('network down')
        if (n === 2) return { v: 1, epoch: e, cursor: c, events: [], resync: true }
        return real.events(c, e)
      }),
      command: (c) => real.command(c),
    }
    const status: string[] = []
    const h = startSync(api, { intervalMs: 5, onState: () => {}, onStatus: (s) => status.push(s) })
    await wait(120)
    h.stop()
    expect(status).toContain('error')
    expect((api.snapshot as any).mock.calls.length).toBeGreaterThanOrEqual(3)
  })
})

// A controllable adapter: every snapshot()/events() call returns a promise the test resolves by hand.
function deferredApi() {
  const real = new MockApi(() => 0, 1e9)
  const snaps: { resolve(): void }[] = []
  const evs: { resolve(): void }[] = []
  const api: FoundryApi = {
    simulated: true,
    snapshot: vi.fn(() => new Promise((res) => { snaps.push({ resolve: () => res(real.snapshot()) }) })) as FoundryApi['snapshot'],
    events: vi.fn((c: string, e: string) => new Promise<EventsReply>((res) => { evs.push({ resolve: () => res(real.events(c, e)) }) })),
    command: (c) => real.command(c),
  }
  return { api, snaps, evs, real }
}
const flush = () => wait(0)

describe('sync loop: concurrency and teardown', () => {
  it('resync during a pending request keeps one request in flight and discards the stale completion', async () => {
    const { api, snaps } = deferredApi()
    const states: PaneState[] = []
    const h = startSync(api, { intervalMs: 5, onState: (s) => states.push(s) })
    await flush()
    expect(snaps).toHaveLength(1)
    h.resync(); h.resync(); h.resync() // three command-triggered resyncs while the first snapshot is pending
    await flush()
    expect(snaps).toHaveLength(1) // no second request started in parallel
    snaps[0].resolve() // the stale completion
    await wait(10)
    expect(states).toHaveLength(0) // discarded: it must not overwrite newer state
    expect(snaps).toHaveLength(2) // exactly one follow-up request, issued after the first settled
    snaps[1].resolve()
    await wait(10)
    expect(states).toHaveLength(1)
    h.stop()
  })
  it('never accumulates poll chains: after many resyncs there is still at most one request pending', async () => {
    const { api, snaps, evs } = deferredApi()
    const h = startSync(api, { intervalMs: 5, onState: () => {} })
    await flush()
    snaps[0].resolve(); await wait(10)
    for (let i = 0; i < 20; i++) h.resync()
    await wait(20)
    const pending = (snaps.length - 1 - 0) + evs.length
    expect(api.snapshot).toHaveBeenCalledTimes(snaps.length)
    expect(pending).toBeLessThanOrEqual(2) // the original events request (stale) plus one snapshot refetch
    h.stop()
  })
  it('a pending snapshot that resolves after stop() calls no callback and schedules nothing', async () => {
    const { api, snaps } = deferredApi()
    const onState = vi.fn(); const onStatus = vi.fn()
    const h = startSync(api, { intervalMs: 5, onState, onStatus })
    await flush()
    h.stop()
    snaps[0].resolve()
    await wait(30)
    expect(onState).not.toHaveBeenCalled()
    expect(onStatus).not.toHaveBeenCalledWith('live')
    expect(api.snapshot).toHaveBeenCalledTimes(1)
    expect(api.events).not.toHaveBeenCalled()
  })
  it('a pending events request that resolves after stop() does not refetch or report', async () => {
    const { api, snaps, evs } = deferredApi()
    const onState = vi.fn()
    const h = startSync(api, { intervalMs: 5, onState })
    await flush(); snaps[0].resolve(); await wait(20)
    expect(evs.length).toBe(1)
    const before = onState.mock.calls.length
    h.stop()
    evs[0].resolve()
    await wait(30)
    expect(onState.mock.calls.length).toBe(before)
    expect(api.events).toHaveBeenCalledTimes(1)
  })
  it('resync() after stop() is a no-op', async () => {
    const { api } = deferredApi()
    const h = startSync(api, { intervalMs: 5, onState: () => {} })
    await flush(); h.stop(); h.resync(); await wait(20)
    expect(api.snapshot).toHaveBeenCalledTimes(1)
  })
})

describe('sync loop: comments and poll', () => {
  it('a comment survives a snapshot refetch in the same epoch, and poll() fetches events without a snapshot', async () => {
    let t = 0
    const real = new MockApi(() => t, 1e9)
    const api: FoundryApi = { simulated: true, snapshot: vi.fn(() => real.snapshot()), events: (c, e) => real.events(c, e), command: (c) => real.command(c) }
    const states: PaneState[] = []
    const h = startSync(api, { intervalMs: 1000, onState: (s) => states.push(s) })
    await wait(10)
    expect(await api.command({ type: 'comment', card_id: 'main:t1', text: 'hi' })).toEqual({ ok: true })
    h.poll()
    await wait(20)
    expect(states.at(-1)!.comments.map((c) => c.text)).toEqual(['hi'])
    expect(api.snapshot).toHaveBeenCalledTimes(1)
    h.resync()
    await wait(20)
    expect(api.snapshot).toHaveBeenCalledTimes(2)
    expect(states.at(-1)!.comments.map((c) => c.text)).toEqual(['hi'])
    h.stop()
  })
})
