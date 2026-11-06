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
