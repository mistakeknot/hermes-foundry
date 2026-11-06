// Drag-a-climber-onto-a-scale gesture: the decision logic, kept free of three.js and React so it is easy to test.
//
// The only thing a drop can do is ask the pane to open the card and focus its profile selector, the same picker
// the profile buttons use. A drop never produces a Command: a worker exposes no profile (so none is inferred from it),
// and nothing here claims the card. Dropping anywhere that is not a scale is a no-op.
import { findCard } from './reducer'
import type { Pick } from './scene'
import type { Snapshot } from './types'

/** What the pane should do after a drop. There is deliberately no field that could carry a command or a profile. */
export interface AssignRequest {
  cardId: string
  workerId: string
  /** Bumped per drop so dropping on the same card twice refocuses the selector. */
  seq: number
}

export type DropOutcome = { open: AssignRequest } | null

/** A drop on a scale (a card) opens the selector for that card; everything else, including a drop on the
 *  carvings, a creature body, another climber or empty space, does nothing. */
export function dropOutcome(workerId: string | null, target: Pick | null, seq: number): DropOutcome {
  if (!workerId || !target || target.kind !== 'card') return null
  return { open: { cardId: target.id, workerId, seq } }
}

/** Pointer travel (px) below which a press on a climber is a click, not a drag. Matches the scene's click slop. */
export const DRAG_SLOP = 5

export function isDrag(down: { x: number; y: number }, up: { x: number; y: number }): boolean {
  return Math.hypot(up.x - down.x, up.y - down.y) > DRAG_SLOP
}

export interface DropUi {
  /** The card to show in the side panel. */
  pick: { kind: 'card'; id: string }
  request: AssignRequest
  /** A hint only; nothing was sent. */
  notice: string
}

/** The pane's whole response to a drop. It returns UI state only (no Command), so a drop cannot claim or assign.
 *  The assignment itself happens only when the user picks a profile in the selector, which sends `assign`. */
export function dropUi(req: AssignRequest, snap: Snapshot): DropUi | null {
  const card = findCard(snap, req.cardId)
  if (!card) return null // the card vanished between press and drop
  const w = snap.workers.find((x) => x.id === req.workerId)
  return {
    pick: { kind: 'card', id: card.id },
    request: req,
    notice: `Choose a profile for “${card.title}”. Dropping ${w?.name ?? 'a climber'} here does not claim it.`,
  }
}
