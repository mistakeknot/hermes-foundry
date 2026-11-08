import { describe, expect, it } from 'vitest'
import { FLOOR_Y, valleyHeight, valleySize, type Phases } from '../src/terrain'
import { parseSimpleColor, luminance } from '../src/themecolor'

const PH: Phases = [1.3, 4.1, 2.7]

describe('valleyHeight: creatures stand on the floor, not under it', () => {
  it.each([10, 24, 48, 90])('never rises above the creatures\' feet (y = 0) inside a floor of radius %i', (R) => {
    let max = -Infinity, min = Infinity
    for (let a = 0; a < 360; a += 5) for (let d = 0; d <= R; d += R / 12) {
      const h = valleyHeight(Math.cos((a * Math.PI) / 180) * d, Math.sin((a * Math.PI) / 180) * d, R, PH)
      max = Math.max(max, h); min = Math.min(min, h)
    }
    expect(max).toBeLessThanOrEqual(0)
    expect(min).toBeGreaterThan(FLOOR_Y - 0.5) // and not a pit either
  })
  it('the old shape did bury a ring of radius 30 (regression for the report: creatures under the land)', () => {
    // the pre-fix height at d = 30: bowl^2 * 22 - 1.2 plus ripples at best -2.45
    const old = (d: number) => Math.min(1, d / 55) ** 2 * 22 - 1.2
    expect(old(30)).toBeGreaterThan(5)
    expect(valleyHeight(30, 0, 40, PH)).toBeLessThanOrEqual(0)
  })
  it('rises into a rim beyond the floor', () => {
    expect(valleyHeight(10 + 55 + 10, 0, 10, PH)).toBeGreaterThan(15)
  })
  it('sizes the plane to hold the floor, the rim and a margin', () => {
    for (const R of [10, 60, 120]) expect(valleySize(R)).toBeGreaterThanOrEqual(2 * (R + 55))
    expect(valleySize(1)).toBeGreaterThanOrEqual(140)
  })
})

describe('parseSimpleColor', () => {
  it('reads hex and rgb forms', () => {
    expect(parseSimpleColor('#0c1210')).toBe(0x0c1210)
    expect(parseSimpleColor('#fff')).toBe(0xffffff)
    expect(parseSimpleColor(' rgb(12, 18, 16) ')).toBe(0x0c1210)
    expect(parseSimpleColor('rgba(12 18 16 / 0.5)')).toBe(0x0c1210)
  })
  it('leaves modern forms to the browser', () => {
    expect(parseSimpleColor('oklch(0.2 0 0)')).toBeNull()
    expect(parseSimpleColor('color-mix(in oklch, red 10%, white)')).toBeNull()
    expect(parseSimpleColor('')).toBeNull()
  })
  it('orders brightness', () => {
    expect(luminance(0xffffff)).toBeGreaterThan(luminance(0x0c1210))
  })
})
