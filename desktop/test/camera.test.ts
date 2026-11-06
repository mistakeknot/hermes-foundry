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
import { HEADER_PX, EDGE_PX, creaturePoints, ndcLimits, placeLabels, labelBox, overlaps, type LabelIn } from '../src/framing'
import { buildFixture } from '../src/mock'
import { applySnapshot } from '../src/reducer'
import type { Snapshot } from '../src/types'

beforeAll(() => {
  const g = globalThis as Record<string, unknown>
  g.document = { createElement: () => ({ style: {}, remove() {}, textContent: '' }) }
  g.requestAnimationFrame = () => 0
  g.cancelAnimationFrame = () => {}
})

function fakeCanvas(w = 800, h = 600) {
  return { style: {}, addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }), clientWidth: w, clientHeight: h, ownerDocument: { addEventListener() {}, removeEventListener() {} }, getRootNode: () => ({ addEventListener() {}, removeEventListener() {} }), setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false }
}
const mk = (w = 800, h = 600) => new FoundryScene(fakeCanvas(w, h) as any, { appendChild() {} } as unknown as HTMLElement, { onPick() {}, onHover() {} }) as any

/** The fixture, widened to n projects so a crowded valley is covered too. */
function snapshotWith(n: number): Snapshot {
  const base = applySnapshot(buildFixture()).snap
  const projects = Array.from({ length: n }, (_, i) => {
    const src = base.projects[i % base.projects.length]
    return { ...src, id: `${src.id}-${i}`, name: `${src.name} ${i}`, cards: src.cards.map((c) => ({ ...c, id: `${c.id}-${i}` })) }
  })
  return { ...base, projects } as Snapshot
}

const SIZES: [number, number][] = [[1280, 633], [920, 600], [600, 800], [400, 300], [1600, 500]]

/** Screen-space bounds of everything a creature draws, as the camera currently sees it. */
function extents(scene: any) {
  const pts: THREE.Vector3[] = []
  for (const v of scene.creatures.values()) pts.push(...creaturePoints(v.center, v.spec))
  const p = new THREE.Vector3()
  const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
  for (const q of pts) { p.copy(q).project(scene.camera); b.minX = Math.min(b.minX, p.x); b.maxX = Math.max(b.maxX, p.x); b.minY = Math.min(b.minY, p.y); b.maxY = Math.max(b.maxY, p.y) }
  return b
}

describe('default camera frames every creature', () => {
  for (const n of [3, 8]) for (const [w, h] of SIZES) it(`${n} creatures in a ${w}x${h} pane: nothing cropped, header clear, and the view is filled`, () => {
    const scene = mk(w, h)
    scene.update(snapshotWith(n))
    scene.resize(w, h)
    const lim = ndcLimits(w, h)
    const b = extents(scene)
    const eps = 1e-3
    expect(b.maxX).toBeLessThanOrEqual(lim.x + eps)
    expect(b.minX).toBeGreaterThanOrEqual(-lim.x - eps)
    expect(b.maxY).toBeLessThanOrEqual(lim.yTop + eps)
    expect(b.minY).toBeGreaterThanOrEqual(-lim.yBottom - eps)
    // fills the view: the content spans most of the free width or height, so creatures are as large as the pane allows
    const fillX = (b.maxX - b.minX) / (2 * lim.x), fillY = (b.maxY - b.minY) / (lim.yTop + lim.yBottom)
    expect(Math.max(fillX, fillY)).toBeGreaterThan(0.9)
    // the pixel margins are real pixels
    expect(((lim.yTop >= 0 ? 1 - lim.yTop : 0) * h) / 2).toBeCloseTo(HEADER_PX, 0)
    expect(((1 - lim.x) * w) / 2).toBeCloseTo(EDGE_PX, 0)
  })

  it('framing happens whether data or size arrives first', () => {
    const a = mk(); a.update(snapshotWith(3)); a.resize(900, 600)
    const b = mk(); b.resize(900, 600); b.update(snapshotWith(3))
    expect(a.camera.position.distanceTo(b.camera.position)).toBeLessThan(1e-6)
  })

  it('a resize reframes until the user moves the camera, then leaves the view alone', () => {
    const scene = mk(); scene.update(snapshotWith(3)); scene.resize(1280, 633)
    const first = scene.camera.position.clone()
    scene.resize(500, 700)
    expect(scene.camera.position.distanceTo(first)).toBeGreaterThan(1) // reframed for the new shape
    const lim = ndcLimits(500, 700), b = extents(scene)
    expect(b.maxX).toBeLessThanOrEqual(lim.x + 1e-3)
    scene.controls.dispatchEvent({ type: 'start' }) // the user grabs the camera
    const mine = scene.camera.position.clone()
    scene.resize(1280, 633)
    expect(scene.camera.position.distanceTo(mine)).toBe(0)
  })

  it('zoom-out limit always reaches the framed view', () => {
    const scene = mk(400, 300); scene.update(snapshotWith(8)); scene.resize(400, 300)
    expect(scene.controls.maxDistance).toBeGreaterThanOrEqual(scene.camera.position.distanceTo(scene.controls.target))
  })
})

const L = (x: number, y: number, o: Partial<LabelIn> = {}): LabelIn => ({ x, y, width: 60, dist: 30, pinned: false, ...o })

describe('placeLabels', () => {
  const W = 800, H = 600
  it('hides a label that would sit in the header band, keeps the same label lower down', () => {
    const [hi, lo] = placeLabels([L(400, HEADER_PX + 5), L(400, HEADER_PX + 40)], [], W, H)
    expect(hi.show).toBe(false)
    expect(lo.show).toBe(true)
  })
  it('of two overlapping labels keeps the nearer one', () => {
    const [far, near] = placeLabels([L(300, 300, { dist: 50 }), L(310, 305, { dist: 20 })], [], W, H)
    expect(near.show).toBe(true)
    expect(far.show).toBe(false)
  })
  it('a pinned label (hovered or selected creature) beats a nearer one', () => {
    const [pin, near] = placeLabels([L(300, 300, { dist: 60, pinned: true }), L(310, 305, { dist: 10 })], [], W, H)
    expect(pin.show).toBe(true)
    expect(pin.opacity).toBeCloseTo(0.92)
    expect(near.show).toBe(false)
  })
  it('stays off climber rings', () => {
    const ring = { l: 290, r: 322, t: 280, b: 312 }
    const [onRing, clear] = placeLabels([L(300, 310), L(300, 400)], [ring], W, H)
    expect(onRing.show).toBe(false)
    expect(clear.show).toBe(true)
  })
  it('fades with distance and drops a label that has faded out', () => {
    const [a, b, c] = placeLabels([L(100, 200, { dist: 30 }), L(300, 200, { dist: 62 }), L(500, 200, { dist: 200 })], [], W, H, 45, 80)
    expect(a.opacity).toBeCloseTo(0.92)
    expect(b.show).toBe(true)
    expect(b.opacity).toBeLessThan(a.opacity)
    expect(c.show).toBe(false)
  })
  it('slides an edge label inside the pane rather than cropping it', () => {
    const [left, right] = placeLabels([L(2, 200), L(W - 1, 300)], [], W, H)
    for (const o of [left, right]) {
      expect(o.show).toBe(true)
      const b = labelBox(o.x, o.y, 60)
      expect(b.l).toBeGreaterThanOrEqual(4)
      expect(b.r).toBeLessThanOrEqual(W - 4)
    }
  })
  it('hides a label whose anchor is far off the pane', () => {
    const [a] = placeLabels([L(-300, 200)], [], W, H)
    expect(a.show).toBe(false)
  })
})

describe('the scene draws no colliding labels', () => {
  for (const [w, h] of SIZES) it(`${w}x${h}: shown labels clear the header, stay in the pane, miss every climber ring and each other`, () => {
    const scene = mk(w, h); scene.update(snapshotWith(3)); scene.resize(w, h)
    scene.animateClimbers(5, 1)
    scene.positionLabels()
    const boxes: ReturnType<typeof labelBox>[] = []
    let shown = 0
    for (const v of scene.creatures.values()) for (const l of v.labels) {
      if (l.el.style.display !== 'block') continue
      shown++
      const text = l.el.textContent as string
      boxes.push(labelBox(parseFloat(l.el.style.left), parseFloat(l.el.style.top), text.length * 6.4 + 8))
    }
    expect(shown).toBeGreaterThan(0)
    const rings: ReturnType<typeof labelBox>[] = []
    const q = new THREE.Vector3()
    for (const c of scene.climbers.values()) { q.copy(c.mesh.position).project(scene.camera); const x = (q.x * 0.5 + 0.5) * w, y = (-q.y * 0.5 + 0.5) * h; rings.push({ l: x - 16, r: x + 16, t: y - 16, b: y + 16 }) }
    boxes.forEach((a, i) => {
      expect(a.t).toBeGreaterThanOrEqual(HEADER_PX)
      expect(a.l).toBeGreaterThanOrEqual(4 - 1e-6); expect(a.r).toBeLessThanOrEqual(w - 4 + 1e-6); expect(a.b).toBeLessThanOrEqual(h - 4 + 1e-6)
      for (const r of rings) expect(overlaps(a, r)).toBe(false)
      for (let j = i + 1; j < boxes.length; j++) expect(overlaps(a, boxes[j])).toBe(false)
    })
  })

  it('the hovered project is placed first, so it never shows fewer labels than when nothing is hovered', () => {
    const scene = mk(); scene.update(snapshotWith(8)); scene.resize(800, 600)
    const shownOf = (v: any) => v.labels.filter((l: any) => l.el.style.display === 'block').length
    for (const v of scene.creatures.values()) {
      scene.hoverProject = null
      scene.positionLabels()
      const without = shownOf(v)
      scene.hoverProject = v.spec.projectId
      scene.positionLabels()
      expect(shownOf(v)).toBeGreaterThanOrEqual(without)
      for (const l of v.labels) if (l.el.style.display === 'block') expect(parseFloat(l.el.style.opacity)).toBeCloseTo(0.92)
    }
  })
  it('selecting a card pins the labels of the creature that holds it', () => {
    const scene = mk(); scene.update(snapshotWith(3)); scene.resize(800, 600)
    const v = [...scene.creatures.values()][1]
    scene.select([...v.cardPos.keys()][0])
    expect(scene.pinnedProject()).toBe(v.spec.projectId)
    scene.select(null)
    expect(scene.pinnedProject()).toBeNull()
  })
})
