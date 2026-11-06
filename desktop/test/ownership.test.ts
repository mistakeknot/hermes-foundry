import { describe, expect, it } from 'vitest'
import { applyReply, applySnapshot, claimedWithoutClimber, instantOf, recomputeWorkers } from '../src/reducer'
import { MockApi, buildFixture } from '../src/mock'
import type { Card, Snapshot } from '../src/types'

// Snapshot with one worker and several cards, each claimed by that worker.
function claimSnap(cards: { id: string; at: string }[]): Snapshot {
  const s = buildFixture()
  for (const p of s.projects) for (const c of p.cards) c.claimed_by = null
  s.workers = [{ id: 'w1', name: 'W', state: 'working', card_id: null }]
  const all = s.projects.flatMap((p) => p.cards)
  for (const { id, at } of cards) {
    const c = all.find((x) => x.id === id)!
    c.claimed_by = 'w1'; c.updated_at = at
  }
  return s
}
const holder = (cards: { id: string; at: string }[]) => recomputeWorkers(claimSnap(cards)).workers[0].card_id

describe('ownership compares UTC instants, then the greatest card id', () => {
  it('10:00+02:00 is older than 09:00Z (08:00Z vs 09:00Z)', () => {
    expect(holder([{ id: 'main:t1', at: '2026-11-07T10:00:00+02:00' }, { id: 'main:t2', at: '2026-11-07T09:00:00Z' }])).toBe('main:t2')
    expect(holder([{ id: 'main:t2', at: '2026-11-07T09:00:00Z' }, { id: 'main:t1', at: '2026-11-07T10:00:00+02:00' }])).toBe('main:t2')
  })
  it('fractional seconds decide before the id', () => {
    expect(holder([{ id: 'main:t3', at: '2026-11-07T09:00:00.100Z' }, { id: 'main:t1', at: '2026-11-07T09:00:00.900Z' }])).toBe('main:t1')
  })
  it('equal instants in different notation tie, then the greatest id wins', () => {
    const a = '2026-11-07T11:00:00+02:00', b = '2026-11-07T09:00:00Z', c = '2026-11-07T04:00:00-05:00'
    expect(holder([{ id: 'main:t1', at: a }, { id: 'main:t9', at: b }])).toBe('main:t9')
    expect(holder([{ id: 'main:t9', at: c }, { id: 'main:t1', at: a }])).toBe('main:t9')
  })
  it('sub-millisecond precision decides before the id (Date.parse would tie these)', () => {
    expect(holder([{ id: 'main:t9', at: '2026-11-07T09:00:00.000100Z' }, { id: 'main:t1', at: '2026-11-07T09:00:00.000900Z' }])).toBe('main:t1')
    expect(holder([{ id: 'main:t1', at: '2026-11-07T09:00:00.000900Z' }, { id: 'main:t9', at: '2026-11-07T09:00:00.000100Z' }])).toBe('main:t1')
    expect(holder([{ id: 'main:t9', at: '2026-11-07T09:00:00.123456788Z' }, { id: 'main:t1', at: '2026-11-07T09:00:00.123456789+00:00' }])).toBe('main:t1')
    // same instant with trailing zeros and another offset still ties, then the greatest id
    expect(holder([{ id: 'main:t1', at: '2026-11-07T11:00:00.000900+02:00' }, { id: 'main:t9', at: '2026-11-07T09:00:00.0009Z' }])).toBe('main:t9')
  })
  it('fractions longer than nine digits still order (no truncation)', () => {
    expect(holder([{ id: 'main:t9', at: '2026-11-07T09:00:00.1234567891Z' }, { id: 'main:t1', at: '2026-11-07T09:00:00.1234567899Z' }])).toBe('main:t1')
    expect(holder([{ id: 'main:t1', at: '2026-11-07T09:00:00.1234567899Z' }, { id: 'main:t9', at: '2026-11-07T09:00:00.1234567891Z' }])).toBe('main:t1')
    // a 12-digit difference past the ninth digit, and a short fraction against a longer one
    expect(holder([{ id: 'main:t9', at: '2026-11-07T09:00:00.123456789000Z' }, { id: 'main:t1', at: '2026-11-07T09:00:00.123456789001Z' }])).toBe('main:t1')
    expect(holder([{ id: 'main:t1', at: '2026-11-07T09:00:00.5Z' }, { id: 'main:t9', at: '2026-11-07T09:00:00.50000000000001Z' }])).toBe('main:t9')
    // genuinely equal (trailing zeros past any width): the greatest id wins
    expect(holder([{ id: 'main:t1', at: '2026-11-07T09:00:00.5000000000000Z' }, { id: 'main:t9', at: '2026-11-07T09:00:00.5Z' }])).toBe('main:t9')
  })
  it('a newer card with a smaller id beats an older card with a greater id', () => {
    expect(holder([{ id: 'main:t9', at: '2026-11-07T09:00:00Z' }, { id: 'main:t1', at: '2026-11-07T09:00:01Z' }])).toBe('main:t1')
  })
  it('an offset-less or unparseable timestamp counts as oldest', () => {
    expect(instantOf('2026-11-07T09:00:00')).toBeNull()
    expect(instantOf('not a time')).toBeNull()
    expect(instantOf('2026-11-07T09:00:00Z')).not.toBeNull()
    expect(holder([{ id: 'main:t9', at: '2026-11-07T23:00:00' }, { id: 'main:t1', at: '2026-11-07T00:00:00Z' }])).toBe('main:t1')
  })
})

describe('claimedWithoutClimber', () => {
  const card = (id: string, claimed_by: string | null) => ({ id, claimed_by } as never)
  const w = (id: string, card_id: string | null) => ({ id, card_id } as never)
  it('marks a secondary claim, not the climbed card, not a missing worker, not an unclaimed card', () => {
    const workers = [w('fx:1', 'main:t1')]
    expect(claimedWithoutClimber(card('main:t2', 'fx:1'), workers)).toBe(true)
    expect(claimedWithoutClimber(card('main:t1', 'fx:1'), workers)).toBe(false)
    expect(claimedWithoutClimber(card('main:t3', 'fx:gone'), workers)).toBe(false)
    expect(claimedWithoutClimber(card('main:t4', null), workers)).toBe(false)
  })
})

describe('mock fixture shares the reducer derivation', () => {
  const make = () => { let t = 0; return new MockApi(() => t, 1e9) }

  it('conflicting claims through commands: raw snapshot equals the reducer output', async () => {
    const api = make()
    for (const id of ['main:t3', 'main:t2', 'docs:t1']) expect(await api.command({ type: 'claim', card_id: id, worker_id: 'fx:4' })).toEqual({ ok: true })
    const raw = await api.snapshot()
    const derived = applySnapshot(raw).snap
    expect(raw.workers).toEqual(derived.workers)
    // fx:4 holds the card claimed last (latest updated_at), not the first one in traversal order
    expect(raw.workers.find((w) => w.id === 'fx:4')!.card_id).toBe('docs:t1')
    const claimed = raw.projects.flatMap((p) => p.cards).filter((c) => c.claimed_by === 'fx:4').map((c: Card) => c.id)
    expect(claimed).toEqual(expect.arrayContaining(['main:t3', 'main:t2', 'docs:t1'])) // the other claims stay on their cards
  })
})

describe('mock event log is bounded', () => {
  it('keeps at most logMax events and answers an expired cursor with resync:true', async () => {
    let t = 0
    const api = new MockApi(() => t, 1e9, 1, 5)
    const s0 = applySnapshot(await api.snapshot())
    for (let i = 0; i < 12; i++) await api.command({ type: 'stand', on: i % 2 === 0 })
    const stale = await api.events(s0.cursor, s0.epoch)
    expect(stale.resync).toBe(true)
    expect(stale.events).toEqual([])
    // a cursor inside the retained window still streams
    const s1 = applySnapshot(await api.snapshot())
    await api.command({ type: 'stand', on: true })
    const rep = await api.events(s1.cursor, s1.epoch)
    expect(rep.resync).toBe(false)
    expect(applyReply(s1, rep).state.snap.paused).toBe(true)
    expect(((api as unknown) as { log: unknown[] }).log.length).toBeLessThanOrEqual(5)
  })
})
