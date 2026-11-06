// How a scale looks for each card status. Pure data, so it is unit-testable and the fixture and live paths share it.
// The colour comes from STATUS_COLOR (the legend chips use the same table); this adds the other two channels that make
// status readable at a glance from the default camera: size (width `w`, height `h`) and light (`glow`, `stone`).
import type { Card } from './types'

const KNOWN: ReadonlySet<string> = new Set(['open', 'running', 'blocked', 'review', 'done', 'unknown'])

/** A status the pane does not recognise (a newer source, a bad payload) is treated as 'unknown', never looked up raw. */
export function knownStatus(s: unknown): Card['status'] {
  return typeof s === 'string' && KNOWN.has(s) ? (s as Card['status']) : 'unknown'
}

export interface StatusLook {
  /** width multiplier of the hex (across the limb) */
  w: number
  /** height multiplier (how far it stands off the limb) */
  h: number
  /** emissive strength: the scale lights itself with its own colour. > 1 also pulses. */
  glow: number
  /** 0..1: weathering to stone (greyed, darkened, speckled, flat) */
  stone: number
  /** additive halo around the scale, drawn only where the status asks for one */
  halo: boolean
}

export const STATUS_LOOK: Record<Card['status'], StatusLook> = {
  open: { w: 1.0, h: 1.0, glow: 0, stone: 0, halo: false },
  running: { w: 1.15, h: 1.6, glow: 0.5, stone: 0, halo: false },
  blocked: { w: 1.3, h: 2.2, glow: 1.6, stone: 0, halo: true },
  review: { w: 1.15, h: 1.45, glow: 0.3, stone: 0, halo: false },
  done: { w: 1.0, h: 0.4, glow: 0, stone: 1, halo: false },
  unknown: { w: 0.85, h: 0.8, glow: 0, stone: 0, halo: false },
}

/** Base scale of every hex relative to the spec size (the spec size is limited by limb girth and card spacing). */
export const SCALE_K = 1.4

/** Pulse factor for glows above 1: 0.8..1.2 around 1, a slow breath. */
export function pulse(t: number): number {
  return 1 + 0.2 * Math.sin(t * 2.6)
}
