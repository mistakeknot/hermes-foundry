// Pure reducer: applySnapshot / applyEvent (contract draft 4). No I/O, no clock, no mutation of inputs.
import type { Card, EventsReply, FoundryEvent, PaneState, Snapshot, Worker } from './types'

/** `prev` carries comments across a refresh within the same epoch (a snapshot does not hold comments). */
export function applySnapshot(snap: Snapshot, prev?: PaneState | null): PaneState {
  const s = structuredClone(snap)
  const comments = prev && prev.epoch === s.epoch ? prev.comments : []
  return { snap: recomputeWorkers(s), watermark: s.last_seq, cursor: s.cursor, epoch: s.epoch, comments }
}

const RFC3339 = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2})(?::(\d{2})(?:\.(\d+))?)?([Zz]|[+-]\d{2}:?\d{2})$/

/** A UTC instant: whole epoch seconds plus the fraction digits exactly as written (any length). */
export type Instant = { sec: bigint; frac: string }

/**
 * Parse an RFC 3339 timestamp to whole UTC seconds plus its fraction digits, of any length (Date.parse
 * would truncate to milliseconds). A string without an explicit offset, or that does not parse, returns
 * null and ranks oldest, so it never wins an ownership comparison.
 */
export function parseInstant(ts: string | null | undefined): Instant | null {
  if (typeof ts !== 'string') return null
  const m = RFC3339.exec(ts)
  if (!m) return null
  const [, date, hm, sec, frac, zone] = m
  // whole seconds through Date.parse (offset handling), the fraction kept as a digit string
  const whole = Date.parse(`${date}T${hm}:${sec ?? '00'}${zone.length === 5 && !zone.includes(':') && zone !== 'Z' ? zone.slice(0, 3) + ':' + zone.slice(3) : zone}`)
  if (Number.isNaN(whole)) return null
  return { sec: BigInt(whole) / 1000n, frac: (frac ?? '').replace(/0+$/, '') }
}

/** -1, 0 or 1: whole seconds first, then fractions right-padded to equal width (so .5 equals .500). */
export function compareInstants(a: Instant, b: Instant): number {
  if (a.sec !== b.sec) return a.sec < b.sec ? -1 : 1
  const w = Math.max(a.frac.length, b.frac.length)
  const fa = a.frac.padEnd(w, '0'), fb = b.frac.padEnd(w, '0')
  return fa === fb ? 0 : fa < fb ? -1 : 1
}

/** Integer nanoseconds (fraction truncated to nine digits). For display and tests only; ordering uses compareInstants. */
export function instantOf(ts: string | null | undefined): bigint | null {
  const i = parseInstant(ts)
  return i ? i.sec * 1_000_000_000n + BigInt(i.frac.slice(0, 9).padEnd(9, '0')) : null
}

/** True when card a outranks card b for ownership: later UTC instant (full precision), then the greater card id. */
export function outranks(a: Card, b: Card): boolean {
  const ta = parseInstant(a.updated_at)
  const tb = parseInstant(b.updated_at)
  if (ta === null && tb === null) return a.id > b.id
  if (ta === null) return false
  if (tb === null) return true
  const c = compareInstants(ta, tb)
  return c === 0 ? a.id > b.id : c > 0
}

/** A card whose claimed_by names a known worker that is not climbing this card: drawn as claimed, without a climber. */
export function claimedWithoutClimber(card: Card, workers: Worker[]): boolean {
  if (!card.claimed_by) return false
  const w = workers.find((x) => x.id === card.claimed_by)
  return !!w && w.card_id !== card.id
}

/**
 * claimed_by is the single source (contract draft 4). A worker holds at most one card: the one with the
 * latest updated_at instant (ties: the greatest card id). Other claims stay on their cards. Mutates
 * and returns `s`; the mock fixture uses this same function.
 */
export function recomputeWorkers(s: Snapshot): Snapshot {
  const held = new Map<string, Card>()
  for (const p of s.projects) for (const c of p.cards) {
    if (!c.claimed_by) continue
    const cur = held.get(c.claimed_by)
    if (!cur || outranks(c, cur)) held.set(c.claimed_by, c)
  }
  for (const w of s.workers) w.card_id = held.get(w.id)?.id ?? null
  return s
}

export interface ApplyResult { state: PaneState; resync: boolean }

/** Apply a poll reply. Returns resync=true when the pane must refetch the snapshot. */
export function applyReply(state: PaneState, reply: EventsReply): ApplyResult {
  if (reply.resync || reply.epoch !== state.epoch) return { state, resync: true }
  let next = state
  const events = [...reply.events].sort((a, b) => a.seq - b.seq)
  for (const ev of events) {
    if (ev.seq <= next.watermark) continue // duplicate or replay
    const applied = applyEvent(next, ev)
    if (!applied) return { state, resync: true } // a reference the reducer cannot resolve
    next = applied
  }
  return { state: { ...next, cursor: reply.cursor }, resync: false }
}

/** Apply one event; returns null when it names something the state cannot resolve. */
export function applyEvent(state: PaneState, ev: FoundryEvent): PaneState | null {
  if (ev.seq <= state.watermark) return state
  const snap = structuredClone(state.snap)
  let comments = state.comments
  switch (ev.type) {
    case 'card_upsert': {
      const card = ev.payload.card
      const proj = projectOf(snap, card.id)
      if (!proj) return null
      const i = proj.cards.findIndex((c) => c.id === card.id)
      if (i >= 0) proj.cards[i] = card
      else proj.cards.push(card)
      break
    }
    case 'card_removed': {
      let found = false
      for (const p of snap.projects) {
        const i = p.cards.findIndex((c) => c.id === ev.payload.card_id)
        if (i >= 0) { p.cards.splice(i, 1); found = true }
      }
      if (!found) return null
      break
    }
    case 'comment_added':
      if (!comments.some((c) => c.seq === ev.seq)) comments = [...comments, { ...ev.payload, seq: ev.seq }].slice(-200)
      break
    case 'worker_upsert': {
      const w: Worker = ev.payload.worker
      const i = snap.workers.findIndex((x) => x.id === w.id)
      if (i >= 0) snap.workers[i] = w
      else snap.workers.push(w)
      break
    }
    case 'worker_removed': {
      const i = snap.workers.findIndex((x) => x.id === ev.payload.worker_id)
      if (i >= 0) snap.workers.splice(i, 1) // removing an absent worker is a no-op (idempotent)
      for (const p of snap.projects) for (const c of p.cards) if (c.claimed_by === ev.payload.worker_id) c.claimed_by = null
      break
    }
    case 'paused':
      snap.paused = !!ev.payload.paused
      break
    default:
      return null // an event type this pane does not know: refetch rather than guess
  }
  return { ...state, snap: recomputeWorkers(snap), watermark: ev.seq, comments }
}

/** A card id is "<board>:<native_id>" and a project id is the board slug. */
export function projectOf(snap: Snapshot, cardId: string) {
  const board = cardId.split(':', 1)[0]
  return snap.projects.find((p) => p.id === board)
}

export function findCard(snap: Snapshot, id: string): Card | undefined {
  return projectOf(snap, id)?.cards.find((c) => c.id === id)
}
