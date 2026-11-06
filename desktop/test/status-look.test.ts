import { beforeAll, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'

vi.mock('three', async (orig) => {
  const real = await orig<typeof import('three')>()
  class FakeRenderer {
    shadowMap = { enabled: false }
    info = { memory: { geometries: 0 } }
    setPixelRatio() {}
    setSize() {}
    render() {}
    dispose() {}
    forceContextLoss() {}
    getContext() { return {} }
  }
  return { ...real, WebGLRenderer: FakeRenderer }
})

import { FoundryScene, STATUS_COLOR } from '../src/scene'
import { STATUS_LOOK, pulse } from '../src/status-look'
import { buildFixture } from '../src/mock'
import { applySnapshot } from '../src/reducer'
import type { Card } from '../src/types'

const STATUSES: Card['status'][] = ['open', 'running', 'blocked', 'review', 'done', 'unknown']

describe('status look table', () => {
  it('covers every status and a colour for each', () => {
    for (const s of STATUSES) { expect(STATUS_LOOK[s]).toBeDefined(); expect(STATUS_COLOR[s]).toBeTypeOf('number') }
  })
  it('blocked is the loudest: brightest, tallest, haloed, and the only one that pulses', () => {
    const b = STATUS_LOOK.blocked
    for (const s of STATUSES) if (s !== 'blocked') {
      expect(b.glow).toBeGreaterThan(STATUS_LOOK[s].glow)
      expect(b.h).toBeGreaterThan(STATUS_LOOK[s].h)
      expect(STATUS_LOOK[s].halo).toBe(false)
    }
    expect(b.halo).toBe(true)
    expect(b.glow).toBeGreaterThan(1)
    for (const s of STATUSES) if (s !== 'blocked') expect(STATUS_LOOK[s].glow).toBeLessThanOrEqual(1)
  })
  it('done is stone: flat, unlit, fully weathered; nothing else is stone', () => {
    const d = STATUS_LOOK.done
    expect(d.stone).toBe(1)
    expect(d.glow).toBe(0)
    for (const s of STATUSES) if (s !== 'done') { expect(d.h).toBeLessThan(STATUS_LOOK[s].h); expect(STATUS_LOOK[s].stone).toBe(0) }
  })
  it('pulse stays within 0.8..1.2', () => {
    for (let t = 0; t < 20; t += 0.1) { const p = pulse(t); expect(p).toBeGreaterThanOrEqual(0.8 - 1e-9); expect(p).toBeLessThanOrEqual(1.2 + 1e-9) }
  })
})

beforeAll(() => {
  const g = globalThis as Record<string, unknown>
  g.document = { createElement: () => ({ style: {}, remove() {}, textContent: '' }) }
  g.requestAnimationFrame = () => 0
  g.cancelAnimationFrame = () => {}
})

function fakeCanvas() {
  return { style: {}, addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }), clientWidth: 800, clientHeight: 600, ownerDocument: { addEventListener() {}, removeEventListener() {} }, getRootNode: () => ({ addEventListener() {}, removeEventListener() {} }), setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false } as unknown as HTMLCanvasElement
}
const mk = () => new FoundryScene(fakeCanvas(), { appendChild() {} } as unknown as HTMLElement, { onPick() {}, onHover() {} }) as any

describe('scene applies the look per card status (same path for fixture and live)', () => {
  for (const mode of ['fixture', 'live'] as const) it(`${mode}: every scale carries its status's colour, glow, stone and height`, () => {
    const snap = { ...applySnapshot(buildFixture()).snap, mode } as ReturnType<typeof buildFixture>
    const scene = mk()
    scene.update(snap)
    const seen = new Set<string>()
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), c = new THREE.Color()
    for (const proj of snap.projects) {
      const v = scene.creatures.get(proj.id)
      const aGlow = v.scales.geometry.getAttribute('aGlow'), aStone = v.scales.geometry.getAttribute('aStone')
      for (const card of proj.cards) {
        const i = v.scaleIds.indexOf(card.id)
        if (i < 0) continue
        const look = STATUS_LOOK[card.status]
        seen.add(card.status)
        expect(aGlow.getX(i)).toBeCloseTo(look.glow, 5)
        expect(aStone.getX(i)).toBeCloseTo(look.stone, 5)
        v.scales.getColorAt(i, c)
        expect(c.getHex()).toBe(new THREE.Color(STATUS_COLOR[card.status]).getHex())
        v.scales.getMatrixAt(i, m); m.decompose(p, q, s)
        expect(s.y / s.x).toBeCloseTo(look.h / look.w, 5)
        v.halo.getMatrixAt(i, m); m.decompose(p, q, s)
        expect(s.x > 0).toBe(look.halo)
      }
    }
    expect(seen.has('blocked')).toBe(true)
    expect(seen.has('done')).toBe(true)
  })
})
