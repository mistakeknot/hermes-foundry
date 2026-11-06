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

import { FoundryScene } from '../src/scene'
import { creaturePoints, HEADER_PX, EDGE_PX } from '../src/framing'
import { buildCreature, LIMB_MAX } from '../src/creature'
import { buildFixture } from '../src/mock'
import { applySnapshot } from '../src/reducer'
import { panelWidthFor, NARROW_PX } from '../src/plugin'
import type { Card, Snapshot } from '../src/types'

let created: any[] = []
beforeAll(() => {
  const g = globalThis as Record<string, unknown>
  g.document = { createElement: () => { const el: any = { style: {}, remove() { created = created.filter((x) => x !== el) }, textContent: '' }; created.push(el); return el } }
  g.requestAnimationFrame = () => 0
  g.cancelAnimationFrame = () => {}
})
function fakeCanvas(w: number, h: number) {
  return { style: {}, addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }), clientWidth: w, clientHeight: h, ownerDocument: { addEventListener() {}, removeEventListener() {} }, getRootNode: () => ({ addEventListener() {}, removeEventListener() {} }), setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false }
}
const labelHost = () => ({ appendChild() {} }) as unknown as HTMLElement
function mk(w: number, h: number) {
  const s = new FoundryScene(fakeCanvas(w, h) as any, labelHost(), { onPick() {}, onHover() {} }) as any
  s.resize(w, h); s.flushResize()
  return s
}
/** One project, one epic, n cards: the live case that heaped every card on one limb. */
function oneBigEpic(n: number): Snapshot {
  const base = applySnapshot(buildFixture()).snap
  const src = base.projects[0]
  const cards: Card[] = Array.from({ length: n }, (_, i) => ({ ...structuredClone(src.cards[i % src.cards.length]), id: `big:t${i}`, epic_id: 'big:e', claimed_by: null, docs: [] }))
  const project = { ...src, id: 'big', name: 'big', epics: [{ ...src.epics[0], id: 'big:e', title: 'Everything' }], cards }
  return { ...base, projects: [project], workers: [] } as Snapshot
}

describe('a crowded epic is spread over several limbs', () => {
  it('34 cards in one epic make 3 limbs of at most LIMB_MAX, none lost', () => {
    const c = buildCreature(oneBigEpic(34).projects[0])
    expect(c.limbs.length).toBe(3)
    expect(c.limbs.every((l) => l.scales.length <= LIMB_MAX)).toBe(true)
    expect(c.limbs.reduce((n, l) => n + l.scales.length, 0)).toBe(34)
    expect(c.limbs.map((l) => l.title)).toEqual(['Everything (1/3)', 'Everything (2/3)', 'Everything (3/3)'])
  })
  it('a small epic keeps one limb and its plain title', () => {
    const c = buildCreature(oneBigEpic(LIMB_MAX).projects[0])
    expect(c.limbs.length).toBe(1)
    expect(c.limbs[0].title).toBe('Everything')
  })
  it('the limbs point in different directions', () => {
    const c = buildCreature(oneBigEpic(34).projects[0])
    const dirs = c.limbs.map((l) => Math.atan2(l.path.at(-1)![2], l.path.at(-1)![0]))
    expect(new Set(dirs.map((d) => d.toFixed(2))).size).toBe(3)
  })
})

describe('approaching a creature fits it into the real pane', () => {
  const SIZES: [number, number][] = [[1280, 633], [540, 470], [560, 420], [320, 380]]
  for (const [w, h] of SIZES) {
    it(`${w}x${h}: the whole creature is inside the free rectangle after focusCreature`, () => {
      const s = mk(w, h)
      s.update(applySnapshot(buildFixture()).snap)
      const v = [...s.creatures.values()][1]
      s.focusCreature(v.spec.projectId)
      // run the flight to its end
      for (let i = 0; i < 100 && s.focus; i++) { s.focus.t = Math.min(1, s.focus.t + 0.25); s.controls.target.lerpVectors(s.focus.fromT, s.focus.toT, 1); s.camera.position.copy(s.focus.toP); if (s.focus.t >= 1) s.focus = null }
      s.camera.updateMatrixWorld(true)
      const p = new THREE.Vector3()
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (const q of creaturePoints(v.center, v.spec)) { p.copy(q).project(s.camera); minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y) }
      const px = (x: number) => (x * 0.5 + 0.5) * w, py = (y: number) => (-y * 0.5 + 0.5) * h
      expect(px(minX)).toBeGreaterThanOrEqual(EDGE_PX - 2)
      expect(px(maxX)).toBeLessThanOrEqual(w - EDGE_PX + 2)
      expect(py(maxY)).toBeGreaterThanOrEqual(HEADER_PX - 2)
      expect(py(minY)).toBeLessThanOrEqual(h - EDGE_PX + 2)
    })
  }
  it('a resize re-fits the approached creature until the user orbits', () => {
    const s = mk(1000, 600)
    s.update(applySnapshot(buildFixture()).snap)
    const id = [...s.creatures.keys()][0]
    s.focusCreature(id); s.focus = null
    s.resize(400, 500); s.flushResize()
    const v = s.creatures.get(id)
    const p = new THREE.Vector3().copy(v.center).project(s.camera)
    expect(Math.abs(p.x)).toBeLessThan(0.6) // roughly centred, not cropped off a side
    expect(s.focusedId).toBe(id)
    s.controls.dispatchEvent({ type: 'start' })
    expect(s.focusedId).toBeNull()
  })
})

describe('selection marker', () => {
  it('shows a ring, a pin and a label with the given text, and clears all three', () => {
    const s = mk(800, 600)
    const snap = applySnapshot(buildFixture()).snap
    s.update(snap)
    const id = snap.projects[0].cards[0].id
    s.select(id, 'Rate limit · todo')
    expect(s.selection.visible && s.selectionPin.visible).toBe(true)
    expect(s.selection.scale.x).toBeGreaterThanOrEqual(1)
    expect(s.selectionText).toBe('Rate limit · todo')
    s.select(id) // a snapshot refresh re-selects without text: the label survives
    expect(s.selectionText).toBe('Rate limit · todo')
    s.select(null)
    expect(s.selection.visible || s.selectionPin.visible).toBe(false)
    expect(s.selectionText).toBe('')
  })
  it('no limb colour is close to the blocked hue', async () => {
    const { STATUS_COLOR, MATERIAL_COLOR } = await import('../src/scene')
    const b = new THREE.Color(STATUS_COLOR.blocked)
    for (const [name, hex] of Object.entries(MATERIAL_COLOR)) {
      const c = new THREE.Color(hex as number)
      expect(Math.hypot(c.r - b.r, c.g - b.g, c.b - b.b), name).toBeGreaterThan(0.3)
    }
  })
})

describe('responsive panel', () => {
  it('is 330 wide in a wide or unmeasured pane and never under 220', () => {
    expect(panelWidthFor(0)).toBe(330)
    expect(panelWidthFor(1280)).toBe(330)
    expect(panelWidthFor(540)).toBe(220)
    expect(panelWidthFor(560)).toBe(220)
    expect(panelWidthFor(800)).toBe(304)
    expect(NARROW_PX).toBeGreaterThan(560)
  })
  it('leaves the 3D view at least 300 px at 540 and 560', () => {
    expect(540 - panelWidthFor(540)).toBeGreaterThanOrEqual(300)
    expect(560 - panelWidthFor(560)).toBeGreaterThanOrEqual(300)
  })
})
