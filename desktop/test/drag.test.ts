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

import { FoundryScene, type Pick } from '../src/scene'
import { DRAG_SLOP, dropOutcome, dropUi, isDrag, type AssignRequest } from '../src/drag'
import { buildFixture } from '../src/mock'
import { applySnapshot } from '../src/reducer'
import { FakeCanvas, asCanvas } from './fakecanvas'

beforeAll(() => {
  const g = globalThis as Record<string, unknown>
  g.document = { createElement: () => ({ style: {}, remove() {}, textContent: '' }) }
  g.requestAnimationFrame = () => 0
  g.cancelAnimationFrame = () => {}
})

const card = (id: string): Pick => ({ kind: 'card', id })

describe('dropOutcome: only a scale opens the selector', () => {
  it('a card target opens that card for that climber', () => {
    expect(dropOutcome('w1', card('main:t1'), 7)).toEqual({ open: { cardId: 'main:t1', workerId: 'w1', seq: 7 } })
  })
  it.each([
    ['empty space', null],
    ['a carving', { kind: 'doc', cardId: 'main:t1', path: 'a.md', title: 'A' } as Pick],
    ['a creature body', { kind: 'project', id: 'main' } as Pick],
    ['another climber', { kind: 'worker', id: 'w2' } as Pick],
  ])('a drop on %s is a no-op', (_n, target) => {
    expect(dropOutcome('w1', target, 1)).toBeNull()
  })
  it('no dragged climber is a no-op', () => {
    expect(dropOutcome(null, card('main:t1'), 1)).toBeNull()
  })
  it('the request carries no profile and no command', () => {
    const o = dropOutcome('w1', card('main:t1'), 1)!
    expect(Object.keys(o.open).sort()).toEqual(['cardId', 'seq', 'workerId'])
  })
  it('isDrag uses the click slop', () => {
    expect(isDrag({ x: 0, y: 0 }, { x: DRAG_SLOP, y: 0 })).toBe(false)
    expect(isDrag({ x: 0, y: 0 }, { x: DRAG_SLOP + 1, y: 0 })).toBe(true)
  })
})

/** A real FoundryScene on an ordered fake canvas, with real OrbitControls. pickAt answers from a script so no WebGL is
 *  needed; everything else (listener order, capture, stopImmediatePropagation, bounds) is the production path. */
function harness() {
  const drops: AssignRequest[] = [], picks: (Pick | null)[] = []
  const canvas = new FakeCanvas()
  const scene = new FoundryScene(asCanvas(canvas), { appendChild() {} } as unknown as HTMLElement, { onPick: (p) => picks.push(p), onHover() {}, onDrop: (r) => drops.push(r) }) as any
  let under: Pick | null = null
  scene.pickAt = () => (under ? { pick: under, label: '' } : null)
  const orbitMoved = () => {
    const before = scene.camera.position.clone()
    scene.controls.update()
    return scene.camera.position.distanceTo(before) > 1e-9
  }
  return {
    scene, canvas, drops, picks, orbitMoved,
    over(p: Pick | null) { under = p },
    down(x = 100, id = 1, y = 100) { return canvas.fire('pointerdown', { pointerId: id, x, y }) },
    move(x: number, y = 100, id = 1) { canvas.fire('pointermove', { pointerId: id, x, y }) },
    up(x: number, id = 1, y = 100) { canvas.fire('pointerup', { pointerId: id, x, y }) },
    leave(id = 1) { canvas.fire('pointerleave', { pointerId: id }) },
    cancel(id = 1) { canvas.fire('pointercancel', { pointerId: id }) },
  }
}
const climber: Pick = { kind: 'worker', id: 'w1' }

describe('listener order: a climber press never reaches OrbitControls', () => {
  it('our pointerdown is registered before OrbitControls', () => {
    const t = harness()
    expect(t.canvas.listenerCount('pointerdown')).toBe(2) // ours, then OrbitControls
    t.over(climber)
    const e = t.down()
    expect(e.stopped).toBe(true)
    expect(t.canvas.captured.size).toBe(0) // OrbitControls never called setPointerCapture
    t.move(300); t.move(500)
    expect(t.orbitMoved()).toBe(false) // the camera does not turn under a climber drag
  })
  it('control: a press elsewhere is captured by OrbitControls and orbits', () => {
    const t = harness()
    t.over({ kind: 'project', id: 'main' })
    const e = t.down()
    expect(e.stopped).toBe(false)
    expect(t.canvas.captured.has(1)).toBe(true)
    t.move(300)
    expect(t.orbitMoved()).toBe(true)
  })
  it('after a drag ends, orbit works again', () => {
    const t = harness()
    t.over(climber); t.down(); t.over(null); t.up(300)
    t.over({ kind: 'project', id: 'main' }); t.down(100, 2)
    expect(t.canvas.captured.has(2)).toBe(true)
  })
})

describe('scene gesture', () => {
  it('drag from a climber to a scale reports one drop and gives orbit back', () => {
    const t = harness()
    t.over(climber); t.down()
    expect(t.scene.controls.enabled).toBe(false)
    t.move(160); t.over(card('main:t3')); t.up(160)
    expect(t.drops).toEqual([{ cardId: 'main:t3', workerId: 'w1', seq: 1 }])
    expect(t.picks).toEqual([]) // not also a click
    expect(t.scene.controls.enabled).toBe(true)
  })
  it('dropping on empty space is a no-op', () => {
    const t = harness()
    t.over(climber); t.down()
    t.over(null); t.up(160)
    expect(t.drops).toEqual([])
    expect(t.picks).toEqual([])
    expect(t.scene.controls.enabled).toBe(true)
  })
  it.each([
    ['a carving', { kind: 'doc', cardId: 'main:t1', path: 'a.md', title: 'A' } as Pick],
    ['a creature body', { kind: 'project', id: 'main' } as Pick],
    ['another climber', { kind: 'worker', id: 'w2' } as Pick],
  ])('dropping on %s opens nothing', (_n, target) => {
    const t = harness()
    t.over(climber); t.down()
    t.over(target); t.up(160)
    expect(t.drops).toEqual([])
  })
  it('a drag that starts off a climber is an orbit and never a drop', () => {
    const t = harness()
    t.over({ kind: 'project', id: 'main' }); t.down()
    expect(t.scene.controls.enabled).toBe(true)
    t.over(card('main:t3')); t.up(160)
    expect(t.drops).toEqual([])
  })
  it('a press and release on a climber without travel is a click, not a drop', () => {
    const t = harness()
    t.over(climber); t.down(); t.up(102)
    expect(t.drops).toEqual([])
    expect(t.picks).toEqual([climber])
    expect(t.scene.controls.enabled).toBe(true)
  })
  it('each drop gets a fresh seq, so dropping on the same card twice refocuses', () => {
    const t = harness()
    for (let i = 0; i < 2; i++) { t.over(climber); t.down(); t.over(card('main:t3')); t.up(160) }
    expect(t.drops.map((d) => d.seq)).toEqual([1, 2])
  })
})

describe('leaving the canvas cancels the drag for good', () => {
  const dragOut = (t: ReturnType<typeof harness>, withLeave: boolean) => {
    t.over(climber); t.down()
    t.move(500)
    t.move(900) // outside the 800px canvas
    if (withLeave) t.leave()
  }
  it('with capture (no pointerleave): out, back in, release over a scale does not drop', () => {
    const t = harness()
    dragOut(t, false)
    expect(t.scene.controls.enabled).toBe(false) // still the held press, but the gesture is dead
    t.move(500); t.over(card('main:t3')); t.up(500)
    expect(t.drops).toEqual([])
    expect(t.picks).toEqual([])
    expect(t.scene.controls.enabled).toBe(true)
  })
  it('with capture: releasing outside the canvas does not drop', () => {
    const t = harness()
    dragOut(t, false)
    t.over(card('main:t3')); t.up(900)
    expect(t.drops).toEqual([])
    expect(t.scene.controls.enabled).toBe(true)
  })
  it('without capture (pointerleave fires): out, back in, release over a scale does not drop', () => {
    const t = harness()
    dragOut(t, true)
    t.move(500); t.over(card('main:t3')); t.up(500)
    expect(t.drops).toEqual([])
    expect(t.scene.controls.enabled).toBe(true)
  })
  it('a release in bounds without ever leaving still drops (control)', () => {
    const t = harness()
    t.over(climber); t.down(); t.move(400); t.over(card('main:t3')); t.up(400)
    expect(t.drops).toHaveLength(1)
  })
  it('a pointercancel mid-drag cancels it and a stray release does not drop', () => {
    const t = harness()
    t.over(climber); t.down(); t.cancel()
    expect(t.scene.controls.enabled).toBe(true)
    t.over(card('main:t3')); t.up(160)
    expect(t.drops).toEqual([])
  })
  it('a drag after a cancelled one starts clean', () => {
    const t = harness()
    dragOut(t, false); t.up(900)
    t.over(climber); t.down(); t.over(card('main:t3')); t.up(200)
    expect(t.drops).toHaveLength(1)
  })
})

describe('only the initiating pointer drives the gesture', () => {
  it('a second pointer pressing on a scale cannot be the drop, and the first drag still completes', () => {
    const t = harness()
    t.over(climber); t.down(100, 1)
    t.over(card('main:t3')); const e2 = t.down(300, 2) // second finger lands on a scale
    expect(e2.stopped).toBe(true) // and OrbitControls does not capture it
    expect(t.canvas.captured.has(2)).toBe(false)
    expect(t.scene.controls.enabled).toBe(false)
    t.up(300, 2) // second pointer lifts over the scale
    expect(t.drops).toEqual([])
    expect(t.scene.controls.enabled).toBe(false) // the first press is still held
    t.up(300, 1)
    expect(t.drops).toEqual([{ cardId: 'main:t3', workerId: 'w1', seq: 1 }])
    expect(t.scene.controls.enabled).toBe(true)
  })
  it('first pointer releases first: drops once; the late second release changes nothing', () => {
    const t = harness()
    t.over(climber); t.down(100, 1); t.down(300, 2)
    t.over(card('main:t3')); t.up(300, 1)
    t.up(300, 2)
    expect(t.drops).toHaveLength(1)
    expect(t.scene.controls.enabled).toBe(true)
  })
  it('second pointer releases first over a scale: no drop and orbit stays suspended', () => {
    const t = harness()
    t.over(climber); t.down(100, 1); t.down(300, 2)
    t.over(card('main:t3')); t.up(300, 2)
    expect(t.drops).toEqual([])
    expect(t.scene.controls.enabled).toBe(false)
    t.over(null); t.up(300, 1) // first lets go over nothing
    expect(t.drops).toEqual([])
    expect(t.scene.controls.enabled).toBe(true)
  })
  it('a second pointer cancelling does not cancel the first drag', () => {
    const t = harness()
    t.over(climber); t.down(100, 1); t.down(300, 2)
    t.cancel(2)
    expect(t.scene.controls.enabled).toBe(false)
    t.over(card('main:t3')); t.up(300, 1)
    expect(t.drops).toHaveLength(1)
  })
  it('the first pointer cancelling ends the gesture; the second pointer then cannot drop', () => {
    const t = harness()
    t.over(climber); t.down(100, 1); t.down(300, 2)
    t.cancel(1)
    expect(t.scene.controls.enabled).toBe(true)
    t.over(card('main:t3')); t.up(300, 2)
    expect(t.drops).toEqual([])
  })
  it('a second pointer leaving or moving outside does not cancel the first drag', () => {
    const t = harness()
    t.over(climber); t.down(100, 1); t.down(300, 2)
    t.move(900, 100, 2); t.leave(2)
    t.over(card('main:t3')); t.up(300, 1)
    expect(t.drops).toHaveLength(1)
  })
  it('a second pointer joining a non-climber press does not hijack it into a drag', () => {
    const t = harness()
    const touch = (type: string, x: number, id: number) => t.canvas.fire(type, { pointerId: id, x, y: 100, touch: true })
    t.over({ kind: 'project', id: 'main' }); touch('pointerdown', 100, 1)
    t.over(climber); const e2 = touch('pointerdown', 300, 2) // pinch: second finger happens to land on a climber
    expect(e2.stopped).toBe(false)
    expect(t.scene.controls.enabled).toBe(true)
    t.over(card('main:t3')); touch('pointerup', 300, 2); touch('pointerup', 300, 1)
    expect(t.drops).toEqual([])
  })
})

describe('the drop response is UI state only', () => {
  it('a drop on a card that no longer exists opens nothing', () => {
    const snap = applySnapshot(buildFixture()).snap
    expect(dropUi({ cardId: 'gone:t9', workerId: snap.workers[0].id, seq: 1 }, snap)).toBeNull()
  })
  it('the response names the card and says it does not claim; it carries no command or profile', () => {
    const snap = applySnapshot(buildFixture()).snap
    const target = snap.projects.flatMap((p) => p.cards)[0]
    const ui = dropUi({ cardId: target.id, workerId: snap.workers[0].id, seq: 1 }, snap)!
    expect(ui.pick).toEqual({ kind: 'card', id: target.id })
    expect(ui.notice).toContain('does not claim')
    expect(Object.keys(ui).sort()).toEqual(['notice', 'pick', 'request'])
  })
})
