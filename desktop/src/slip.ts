// The slip: what a climber that reports `looping` does on its card. It is pure motion and never a signal. The pane
// draws it only for a worker whose state is already `looping`; nothing here reads a card, an event or a history, and no
// state is inferred from a worker re-running (the live source cannot say `looping`, so a live climber never slips).
// Each cycle the climber struggles on its hold, slips down the scale, and catches a new hold.

/** Seconds per struggle-slip-catch cycle. */
export const SLIP_PERIOD = 4
/** Radius of the ring of holds the climber works its way around, in world units. */
export const HOLD_RADIUS = 0.7
/** How far a slip drops the climber, in world units. */
export const SLIP_DROP = 0.5
/** Fraction of a cycle at which the slip starts, and at which the catch starts. */
export const SLIP_AT = 0.7
export const CATCH_AT = 0.85
const HOLD_STEP = 2.4 // radians between one hold and the next: never the same hold twice in a row
const ROLL = 0.9 // radians the climber tips while sliding

export interface SlipPose {
  /** Offset from the card, world units. oy is <= 0 (a slip only goes down). */
  ox: number
  oy: number
  oz: number
  /** Tip about the view axis, radians; 0 at rest. */
  roll: number
  /** True from the start of the slide until the climber has caught the new hold. */
  slipping: boolean
  /** Which hold the climber is on (or leaving), counted from 0. */
  hold: number
}

const smooth = (s: number) => s * s * (3 - 2 * s)
const holdAt = (phase: number, k: number) => {
  const a = phase + k * HOLD_STEP
  return { x: Math.cos(a) * HOLD_RADIUS, z: Math.sin(a) * HOLD_RADIUS }
}

/** The pose at time `t` seconds. `phase` staggers climbers; the pose is continuous across cycle boundaries. */
export function slipPose(t: number, phase: number): SlipPose {
  const x = t / SLIP_PERIOD + phase / (2 * Math.PI)
  const hold = Math.floor(x)
  const u = x - hold
  const here = holdAt(phase, hold)
  if (u < SLIP_AT) {
    // struggling: a small shudder, no travel
    return { ox: here.x, oy: 0.04 * Math.abs(Math.sin(u * SLIP_PERIOD * 7)), oz: here.z, roll: 0, slipping: false, hold }
  }
  if (u < CATCH_AT) {
    const s = (u - SLIP_AT) / (CATCH_AT - SLIP_AT) // sliding: accelerates downward
    return { ox: here.x, oy: -SLIP_DROP * s * s, oz: here.z, roll: ROLL * s, slipping: true, hold }
  }
  const e = smooth((u - CATCH_AT) / (1 - CATCH_AT)) // catching: swings to the next hold and rights itself
  const next = holdAt(phase, hold + 1)
  return {
    ox: here.x + (next.x - here.x) * e, oy: -SLIP_DROP * (1 - e), oz: here.z + (next.z - here.z) * e,
    roll: ROLL * (1 - e), slipping: e < 1, hold,
  }
}
