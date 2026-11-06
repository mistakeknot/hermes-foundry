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
import { HEADER_PX, EDGE_PX, MIN_FREE_PX, creaturePoints, ndcLimits, placeLabels, LabelPlacer, labelBox, overlaps, type LabelIn } from '../src/framing'
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
/** resize() is coalesced to the next frame; the older tests want it applied at once, so they flush after each call. */
const syncResize = (scene: any) => { const orig = scene.resize.bind(scene); scene.resize = (w: number, h: number) => { orig(w, h); scene.flushResize() }; return scene }
const mkRaw = (w = 800, h = 600) => new FoundryScene(fakeCanvas(w, h) as any, { appendChild() {} } as unknown as HTMLElement, { onPick() {}, onHover() {} }) as any
const mk = (w = 800, h = 600) => syncResize(mkRaw(w, h))

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

describe('framing holds for crowded valleys and odd pane shapes', () => {
  const within = (scene: any, w: number, h: number) => {
    const lim = ndcLimits(w, h), b = extents(scene), eps = 1e-3
    expect(b.maxX).toBeLessThanOrEqual(lim.x + eps)
    expect(b.minX).toBeGreaterThanOrEqual(-lim.x - eps)
    expect(b.maxY).toBeLessThanOrEqual(lim.yTop + eps)
    expect(b.minY).toBeGreaterThanOrEqual(-lim.yBottom - eps)
    return b
  }
  it('30 creatures at 800x600: nothing cropped, and every point is in front of the far plane', () => {
    const scene = mk(800, 600); scene.update(snapshotWith(30)); scene.resize(800, 600)
    within(scene, 800, 600)
    const d = scene.camera.position.distanceTo(scene.controls.target)
    expect(scene.camera.far).toBeGreaterThan(d)
    for (const v of scene.creatures.values()) for (const q of creaturePoints(v.center, v.spec)) expect(new THREE.Vector3().copy(q).project(scene.camera).z).toBeLessThanOrEqual(1)
  })
  it('8 creatures in a 100x800 pane: nothing cropped (the search bound grows until they fit)', () => {
    const scene = mk(100, 800); scene.update(snapshotWith(8)); scene.resize(100, 800)
    within(scene, 100, 800)
    expect(scene.camera.position.distanceTo(scene.controls.target)).toBeGreaterThan(140) // past the old fixed ceiling
    expect(scene.controls.maxDistance).toBeGreaterThanOrEqual(scene.camera.position.distanceTo(scene.controls.target))
  })
  it('a short pane keeps the creatures clear of the header: 800x100 puts every point below HEADER_PX', () => {
    const scene = mk(800, 100); scene.update(snapshotWith(3)); scene.resize(800, 100)
    const b = within(scene, 800, 100)
    expect(((1 - b.maxY) * 100) / 2).toBeGreaterThanOrEqual(HEADER_PX - 1e-3)
  })
  it('the free rectangle is the pane less the margins, and shrinks side and bottom margins before giving up the header', () => {
    const big = ndcLimits(800, 600)
    expect(big.usable).toBe(true)
    expect(((1 - big.yTop) * 600) / 2).toBeCloseTo(HEADER_PX)
    expect(((1 - big.yBottom) * 600) / 2).toBeCloseTo(EDGE_PX)
    expect(((1 - big.x) * 800) / 2).toBeCloseTo(EDGE_PX)
    const short = ndcLimits(800, 70) // 18px under the header: the bottom margin gives way, the header does not
    expect(short.usable).toBe(true)
    expect(((1 - short.yTop) * 70) / 2).toBeCloseTo(HEADER_PX)
    const free = (short.yTop + short.yBottom) * 70 / 2
    expect(free).toBeGreaterThanOrEqual(MIN_FREE_PX - 1e-6)
    const narrow = ndcLimits(30, 600)
    expect(narrow.usable).toBe(true)
    expect(narrow.x * 30).toBeGreaterThanOrEqual(MIN_FREE_PX - 1e-6)
  })
  it('a pane with no usable area is reported, not clamped, and still frames without throwing', () => {
    for (const [w, h] of [[800, 52], [800, 55], [4, 600], [40, 30]] as [number, number][]) {
      const lim = ndcLimits(w, h)
      expect(lim.usable).toBe(false)
      expect(lim).toMatchObject({ x: 1, yTop: 1, yBottom: 1 })
      const scene = mk(Math.max(w, 2), Math.max(h, 2)); scene.update(snapshotWith(3)); scene.resize(Math.max(w, 2), Math.max(h, 2))
      expect(Number.isFinite(scene.camera.position.x + scene.camera.position.y + scene.camera.position.z)).toBe(true)
      const b = extents(scene)
      expect(b.maxX).toBeLessThanOrEqual(1.001); expect(b.minX).toBeGreaterThanOrEqual(-1.001)
      expect(b.maxY).toBeLessThanOrEqual(1.001); expect(b.minY).toBeGreaterThanOrEqual(-1.001)
    }
    expect(ndcLimits(0, 0).usable).toBe(false)
    expect(ndcLimits(NaN, 600).usable).toBe(false)
  })
})

describe('a frame of label placement allocates nothing once warm', () => {
  it('LabelPlacer rewrites the same records and keeps its order across frames', () => {
    const pl = new LabelPlacer()
    const frame = (dx: number) => {
      pl.begin()
      for (let i = 0; i < 40; i++) pl.add(30 + i * 18 + dx, 300 + (i % 5) * 20, 60, 10 + i, i === 7)
      for (let i = 0; i < 6; i++) pl.addAvoid(100 * i, 280, 100 * i + 30, 310)
      pl.place(900, 600)
    }
    frame(0)
    const outs = pl.out.slice(), order = (pl as any).order, ins = (pl as any).ins.slice(), avoid = (pl as any).avoid.slice(), placed = (pl as any).placed.slice()
    const orderBefore = order.slice()
    frame(1)
    expect(pl.out.length).toBe(40)
    pl.out.forEach((o, i) => expect(o).toBe(outs[i]))
    expect((pl as any).order).toBe(order)
    expect((pl as any).order).toEqual(orderBefore) // nothing re-sorted when nothing moved in rank
    ;(pl as any).ins.forEach((o: unknown, i: number) => expect(o).toBe(ins[i]))
    ;(pl as any).avoid.forEach((o: unknown, i: number) => expect(o).toBe(avoid[i]))
    placed.forEach((o: unknown, i: number) => expect((pl as any).placed[i]).toBe(o))
    expect((pl as any).ins.length).toBe(40)
  })
  it('the order is repaired when ranks change, and pinned still goes first', () => {
    const pl = new LabelPlacer()
    pl.begin(); pl.add(100, 300, 60, 10, false); pl.add(400, 300, 60, 20, false); pl.add(700, 300, 60, 30, false); pl.place(900, 600)
    pl.begin(); pl.add(100, 300, 60, 50, false); pl.add(400, 300, 60, 20, false); pl.add(700, 300, 60, 30, true); pl.place(900, 600)
    expect((pl as any).order).toEqual([2, 1, 0])
  })
  it('the scene touches no DOM property on a frame where nothing changed', () => {
    const scene = mk(); scene.update(snapshotWith(3)); scene.resize(800, 600)
    scene.positionLabels() // warm: first frame writes everything
    let writes = 0
    for (const v of scene.creatures.values()) for (const l of v.labels) {
      for (const k of ['left', 'top', 'opacity', 'display']) {
        let cur = l.el.style[k]
        Object.defineProperty(l.el.style, k, { get: () => cur, set: (x) => { writes++; cur = x }, configurable: true })
      }
      let t = l.el.textContent
      Object.defineProperty(l.el, 'textContent', { get: () => t, set: (x) => { writes++; t = x }, configurable: true })
    }
    scene.positionLabels()
    scene.positionLabels()
    expect(writes).toBe(0)
    scene.camera.position.x += 6; scene.camera.lookAt(scene.controls.target); scene.camera.updateMatrixWorld(true) // a real change does write
    scene.positionLabels()
    expect(writes).toBeGreaterThan(0)
  })
})

describe('hover work queued before the pointer leaves cannot run after it', () => {
  function hoverScene() {
    const handlers: Record<string, (e: any) => void> = {}
    const canvas = { ...fakeCanvas(), addEventListener: (t: string, f: any) => { handlers[t] = f } }
    const hovers: (string | null)[] = []
    const scene = syncResize(new FoundryScene(canvas as any, { appendChild() {} } as unknown as HTMLElement, { onPick() {}, onHover: (t: string | null) => hovers.push(t) }) as any)
    scene.update(snapshotWith(3)); scene.resize(800, 600)
    const project = [...scene.creatures.values()][0].spec.projectId
    scene.pickAt = () => ({ pick: { kind: 'project', id: project }, label: 'hit' })
    const queue: (() => void)[] = []
    ;(globalThis as any).requestAnimationFrame = (f: () => void) => { queue.push(f); return queue.length }
    const ev = (x = 100, y = 200) => ({ clientX: x, clientY: y, buttons: 0, pointerId: 1 })
    return { scene, handlers, queue, hovers, project, ev }
  }
  it('move, leave, then the animation frame: hoverProject stays cleared and nothing is pinned', () => {
    const { scene, handlers, queue, hovers, ev } = hoverScene()
    handlers.pointermove(ev())
    expect(queue.length).toBe(1)
    handlers.pointerleave(ev())
    queue.splice(0).forEach((f) => f())
    expect(scene.hoverProject).toBeNull()
    expect(scene.pinnedProject()).toBeNull()
    expect(hovers.at(-1)).toBeNull()
  })
  it('a move after re-entering is not swallowed by the stale one, and does hover', () => {
    const { scene, handlers, queue, project, ev } = hoverScene()
    handlers.pointermove(ev())
    handlers.pointerleave(ev())
    handlers.pointermove(ev(120, 210)) // back inside before the stale frame fires
    expect(queue.length).toBe(2)
    queue.splice(0).forEach((f) => f())
    expect(scene.hoverProject).toBe(project)
  })
  it('without a leave the queued frame still applies', () => {
    const { scene, handlers, queue, project, ev } = hoverScene()
    handlers.pointermove(ev())
    queue.splice(0).forEach((f) => f())
    expect(scene.hoverProject).toBe(project)
  })
})

describe('framing survives short panes, changing layouts and bad sizes', () => {
  const within = (scene: any, w: number, h: number) => {
    const lim = ndcLimits(w, h), b = extents(scene), eps = 1e-3
    expect(b.maxX).toBeLessThanOrEqual(lim.x + eps)
    expect(b.minX).toBeGreaterThanOrEqual(-lim.x - eps)
    expect(b.maxY).toBeLessThanOrEqual(lim.yTop + eps)
    expect(b.minY).toBeGreaterThanOrEqual(-lim.yBottom - eps)
    return b
  }
  const dist = (scene: any) => scene.camera.position.distanceTo(scene.controls.target)

  for (const h of [60, 70]) it(`8 creatures in an 800x${h} pane: projected into the free band, at a sane distance`, () => {
    const scene = mk(800, h); scene.update(snapshotWith(8)); scene.resize(800, h)
    const b = within(scene, 800, h)
    const lim = ndcLimits(800, h)
    expect(lim.usable).toBe(true)
    // really inside the band under the header, not merely "not NaN"
    expect(b.maxY).toBeLessThanOrEqual(lim.yTop + 1e-3)
    expect(b.minY).toBeGreaterThanOrEqual(-lim.yBottom - 1e-3)
    expect(dist(scene)).toBeLessThan(2e4)
    expect(dist(scene)).toBeLessThan(scene.camera.far)
  })

  it('adding and removing creatures without a resize reframes; a user-moved camera is left alone', () => {
    const scene = mk(800, 600)
    scene.update(snapshotWith(1)); scene.resize(800, 600)
    within(scene, 800, 600)
    const d1 = dist(scene)
    scene.update(snapshotWith(30)) // no resize
    within(scene, 800, 600)
    const d30 = dist(scene)
    expect(d30).toBeGreaterThan(d1)
    scene.update(snapshotWith(2))
    within(scene, 800, 600)
    expect(dist(scene)).toBeLessThan(d30)
    // the creatures that remain still fill most of the free width or height, so the distance is not left over from before
    const lim = ndcLimits(800, 600), b = extents(scene)
    expect(Math.max((b.maxX - b.minX) / (2 * lim.x), (b.maxY - b.minY) / (lim.yTop + lim.yBottom))).toBeGreaterThan(0.6)

    // once the user has the camera, a layout change does not move it
    scene.userMoved = true
    const before = scene.camera.position.clone(), tgt = scene.controls.target.clone()
    scene.update(snapshotWith(12))
    expect(scene.camera.position.distanceTo(before)).toBe(0)
    expect(scene.controls.target.distanceTo(tgt)).toBe(0)
  })

  it('an unchanged snapshot does not reframe', () => {
    const scene = mk(800, 600)
    scene.update(snapshotWith(4)); scene.resize(800, 600)
    const spy = vi.spyOn(scene, 'frameValley')
    scene.update(snapshotWith(4))
    expect(spy).not.toHaveBeenCalledWith(true)
  })

  it('a nonfinite or non-positive size is ignored: the previous valid view survives', () => {
    const scene = mk(800, 600)
    scene.update(snapshotWith(3)); scene.resize(800, 600)
    const pos = scene.camera.position.clone(), aspect = scene.camera.aspect
    for (const [w, h] of [[NaN, 600], [800, NaN], [Infinity, 600], [800, Infinity], [-Infinity, 600], [0, 0], [-5, 600], [1, 600]] as [number, number][]) {
      scene.resize(w, h)
      expect(scene.camera.aspect).toBe(aspect)
      expect(scene.camera.position.distanceTo(pos)).toBe(0)
      for (const c of [scene.camera.position.x, scene.camera.position.y, scene.camera.position.z, scene.camera.aspect]) expect(Number.isFinite(c)).toBe(true)
    }
    scene.resize(500, 700) // and a good size afterwards still works
    expect(scene.camera.aspect).toBeCloseTo(500 / 700)
    within(scene, 500, 700)
  })

  for (const [w, h] of [[60, 10000], [10000, 60], [40, 3000], [3000, 40]] as [number, number][]) {
    it(`30 creatures in an extreme ${w}x${h} pane are all projected inside the free rectangle`, () => {
      const scene = mk(w, h); scene.update(snapshotWith(30)); scene.resize(w, h)
      const lim = ndcLimits(w, h), b = extents(scene), eps = 1e-3
      expect(Number.isFinite(scene.camera.position.length())).toBe(true)
      expect(b.maxX).toBeLessThanOrEqual(lim.x + eps)
      expect(b.minX).toBeGreaterThanOrEqual(-lim.x - eps)
      expect(b.maxY).toBeLessThanOrEqual(lim.yTop + eps)
      expect(b.minY).toBeGreaterThanOrEqual(-lim.yBottom - eps)
    })
  }

  it('removing the hovered project drops its hover, so the selected project is pinned again', () => {
    const scene = mk(800, 600); scene.update(snapshotWith(3)); scene.resize(800, 600)
    const [first, , third] = [...scene.creatures.values()]
    scene.select([...first.cardPos.keys()][0])
    scene.hoverProject = third.spec.projectId
    expect(scene.pinnedProject()).toBe(third.spec.projectId)
    scene.update(snapshotWith(2)) // the third project is gone
    expect(scene.hoverProject).toBeNull()
    expect(scene.pinnedProject()).toBe(first.spec.projectId)
    scene.hoverProject = 'gone-for-good' // and a stale id is never returned even if it slipped in
    expect(scene.pinnedProject()).toBe(first.spec.projectId)
  })

  it('many resizes in one frame cost one reframe, at the last size; nonfinite sizes in between are ignored', () => {
    const scene = mkRaw(800, 600); scene.update(snapshotWith(30))
    scene.resize(800, 600); scene.flushResize()
    const spy = vi.spyOn(scene, 'frameValley')
    for (let i = 0; i < 50; i++) scene.resize(600 + i * 8, 500 + i * 3)
    scene.resize(NaN, 100)
    expect(spy).not.toHaveBeenCalled() // nothing solved while the sizes are still arriving
    scene.loop() // the next frame
    expect(spy).toHaveBeenCalledTimes(1)
    expect(scene.camera.aspect).toBeCloseTo((600 + 49 * 8) / (500 + 49 * 3))
    scene.loop()
    expect(spy).toHaveBeenCalledTimes(1) // nothing pending: no second solve
    within(scene, 600 + 49 * 8, 500 + 49 * 3)
  })

})
