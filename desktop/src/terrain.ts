// Valley terrain height. Pure, so the "creatures stand on the floor" rule is testable without WebGL.

/** Where creatures stand: the floor under them never rises above this (their feet are at y = 0). */
export const FLOOR_Y = -0.25
/** Distance from the flat floor's edge to the full rim height. */
const RIM_RUN = 55
const RIM_HEIGHT = 22
/** Distance over which the ripples fade in beyond the floor. */
const RIPPLE_FADE = 20

export type Phases = [number, number, number]

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/**
 * Height at (x, z) of a valley whose creatures all stand inside `floorRadius`. Inside it the ground is a nearly flat floor
 * (ripples ±0.25 about FLOOR_Y, so never above the creatures' feet); beyond it the ground fades into ripples and
 * rises into the rim. The old shape rose from the origin, which buried every creature on a ring wider than a few units.
 */
export function valleyHeight(x: number, z: number, floorRadius: number, ph: Phases): number {
  const d = Math.hypot(x, z)
  const ripple = Math.sin(x * 0.11 + ph[0]) * 1.1 + Math.cos(z * 0.13 + ph[1]) * 1.0 + Math.sin((x + z) * 0.31 + ph[2]) * 0.35
  const amp = 0.1 + 0.9 * clamp01((d - floorRadius) / RIPPLE_FADE)
  const t = clamp01((d - floorRadius) / RIM_RUN)
  return FLOOR_Y + ripple * amp + t * t * RIM_HEIGHT
}

/** Side of the square ground plane: the floor, the rim and some margin so the edge never shows. */
export function valleySize(floorRadius: number): number {
  return Math.max(140, 2 * (floorRadius + RIM_RUN + 25))
}
