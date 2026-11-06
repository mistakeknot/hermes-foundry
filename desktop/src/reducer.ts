// Pure reducer: applySnapshot / applyEvent (contract draft 3). No I/O, no clock, no mutation of inputs.
import type { Card, EventsReply, FoundryEvent, PaneState, Snapshot, Worker } from './types'

export function applySnapshot(snap: Snapshot): PaneState {
  const s = structuredClone(snap)
  return { snap: recomputeWorkers(s), watermark: s.last_seq, cursor: s.cursor, epoch: s.epoch, comments: [] }
}

/** claimed_by on a card is the single source; a worker's card_id is derived from it. */
export function recomputeWorkers(s: Snapshot): Snapshot {
  const held = new Map<string, string>()
  for (const p of s.projects) for (const c of p.cards) if (c.claimed_by) held.set(c.claimed_by, c.id)
  for (const w of s.workers) w.card_id = held.get(w.id) ?? null
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
      comments = [...comments, { ...ev.payload, seq: ev.seq }].slice(-200)
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
      if (i < 0) return null
      snap.workers.splice(i, 1)
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
