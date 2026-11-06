import { describe, expect, it } from 'vitest'
import { CATCH_AT, HOLD_RADIUS, SLIP_AT, SLIP_DROP, SLIP_PERIOD, slipPose } from '../src/slip'

const at = (u: number, k = 0, phase = 1.3) => slipPose(((k + u) - phase / (2 * Math.PI)) * SLIP_PERIOD, phase)

describe('slipPose', () => {
  it('struggles, then slips, then catches: only the slide and catch count as slipping', () => {
    expect(at(0.3).slipping).toBe(false)
    expect(at((SLIP_AT + CATCH_AT) / 2).slipping).toBe(true)
    expect(at(CATCH_AT + 0.05).slipping).toBe(true)
    expect(at(0.999).slipping).toBe(true) // not caught until the next cycle starts
    expect(at(0.0, 1).slipping).toBe(false)
  })
  it('only ever drops down, by at most SLIP_DROP, and tips while sliding', () => {
    let deepest = 0
    for (let u = 0; u < 3; u += 0.003) {
      const p = at(u % 1, Math.floor(u))
      expect(p.oy).toBeLessThanOrEqual(0.04 + 1e-9) // the shudder lifts a little; a slip never rises further
      expect(p.oy).toBeGreaterThanOrEqual(-SLIP_DROP - 1e-9)
      deepest = Math.min(deepest, p.oy)
    }
    expect(deepest).toBeCloseTo(-SLIP_DROP, 1)
    expect(Math.abs(at(CATCH_AT - 1e-6).roll)).toBeGreaterThan(0.8)
    expect(at(0.3).roll).toBe(0)
  })
  it('catches a new hold: the position after a cycle differs from the one before, on the same ring', () => {
    const before = at(0.5, 0)
    const after = at(0.5, 1)
    expect(Math.hypot(before.ox - after.ox, before.oz - after.oz)).toBeGreaterThan(0.3)
    expect(before.hold).toBe(0)
    expect(after.hold).toBe(1)
    for (const p of [before, after]) expect(Math.hypot(p.ox, p.oz)).toBeCloseTo(HOLD_RADIUS, 6)
  })
  it('is continuous across the cycle boundary and deterministic', () => {
    const a = at(1 - 1e-9, 0), b = at(0, 1)
    expect(a.ox).toBeCloseTo(b.ox, 5); expect(a.oz).toBeCloseTo(b.oz, 5); expect(a.oy).toBeCloseTo(b.oy, 5); expect(a.roll).toBeCloseTo(b.roll, 5)
    expect(slipPose(12.5, 2)).toEqual(slipPose(12.5, 2))
  })
  it('staggers climbers by phase', () => {
    expect(slipPose(1, 0.5)).not.toEqual(slipPose(1, 3))
  })
})
