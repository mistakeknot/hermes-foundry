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
import { MockApi, buildFixture } from '../src/mock'
import { applySnapshot, findCard } from '../src/reducer'
import type { Command } from '../src/types'

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

function fakeCanvas() {
  return { style: {}, addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }), clientWidth: 800, clientHeight: 600, ownerDocument: { addEventListener() {}, removeEventListener() {} }, getRootNode: () => ({ addEventListener() {}, removeEventListener() {} }), setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false } as unknown as HTMLCanvasElement
}

/** A scene whose pickAt answers from a script, so the test drives press / release without WebGL. */
function harness() {
  const drops: AssignRequest[] = [], picks: (Pick | null)[] = []
  const scene = new FoundryScene(fakeCanvas(), { appendChild() {} } as unknown as HTMLElement, { onPick: (p) => picks.push(p), onHover() {}, onDrop: (r) => drops.push(r) }) as any
  let under: Pick | null = null
  scene.pickAt = () => (under ? { pick: under, label: '' } : null)
  const ev = (x: number, y = 0) => ({ clientX: x, clientY: y, button: 0, buttons: 1 }) as PointerEvent
  return {
    scene, drops, picks,
    over(p: Pick | null) { under = p },
    down(x = 0) { scene.onDown(ev(x)) },
    up(x: number) { scene.onUp(ev(x)) },
  }
}

describe('scene gesture', () => {
  it('drag from a climber to a scale reports one drop and gives orbit back', () => {
    const t = harness()
    t.over({ kind: 'worker', id: 'w1' }); t.down()
    expect(t.scene.controls.enabled).toBe(false) // the camera must not orbit under the drag
    t.over(card('main:t3')); t.up(60)
    expect(t.drops).toEqual([{ cardId: 'main:t3', workerId: 'w1', seq: 1 }])
    expect(t.picks).toEqual([]) // not also a click
    expect(t.scene.controls.enabled).toBe(true)
  })
  it('dropping on empty space is a no-op', () => {
    const t = harness()
    t.over({ kind: 'worker', id: 'w1' }); t.down()
    t.over(null); t.up(60)
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
    t.over({ kind: 'worker', id: 'w1' }); t.down()
    t.over(target); t.up(60)
    expect(t.drops).toEqual([])
  })
  it('a drag that starts off a climber is an orbit and never a drop', () => {
    const t = harness()
    t.over({ kind: 'project', id: 'main' }); t.down()
    expect(t.scene.controls.enabled).toBe(true)
    t.over(card('main:t3')); t.up(60)
    expect(t.drops).toEqual([])
  })
  it('a press and release on a climber without travel is a click, not a drop', () => {
    const t = harness()
    t.over({ kind: 'worker', id: 'w1' }); t.down(); t.up(2)
    expect(t.drops).toEqual([])
    expect(t.picks).toEqual([{ kind: 'worker', id: 'w1' }])
    expect(t.scene.controls.enabled).toBe(true)
  })
  it('leaving the canvas or a pointer cancel mid-drag cancels it', () => {
    for (const cancel of ['onLeave', 'onCancel']) {
      const t = harness()
      t.over({ kind: 'worker', id: 'w1' }); t.down()
      t.scene[cancel]()
      expect(t.scene.controls.enabled).toBe(true)
      t.over(card('main:t3')); t.up(60) // a stray release afterwards must not drop
      expect(t.drops).toEqual([])
    }
  })
  it('each drop gets a fresh seq, so dropping on the same card twice refocuses', () => {
    const t = harness()
    for (let i = 0; i < 2; i++) { t.over({ kind: 'worker', id: 'w1' }); t.down(); t.over(card('main:t3')); t.up(60) }
    expect(t.drops.map((d) => d.seq)).toEqual([1, 2])
  })
})

describe('a drop never claims and never infers a profile', () => {
  it('the pane response is UI state only; assigning needs the explicit Assign command', async () => {
    const api = new MockApi(Date.now, 3_600_000)
    const sent: Command[] = []
    const real = api.command.bind(api)
    api.command = async (c: Command) => { sent.push(c); return real(c) }

    const snap = applySnapshot(await api.snapshot()).snap
    const target = snap.projects.flatMap((p) => p.cards).find((c) => c.claimed_by === null)!
    const w = snap.workers.find((x) => !x.card_id) ?? snap.workers[0]
    const before = structuredClone(findCard(snap, target.id)!)

    const out = dropOutcome(w.id, card(target.id), 1)!
    const ui = dropUi(out.open, snap)!
    expect(ui.pick).toEqual({ kind: 'card', id: target.id })
    expect(ui.notice).toContain('does not claim')
    expect(JSON.stringify(ui)).not.toMatch(/profile"|"type"/) // no profile and no command in the response
    expect(sent).toEqual([]) // the drop issued nothing

    const after = applySnapshot(await api.snapshot()).snap
    const c = findCard(after, target.id)!
    expect(c.claimed_by).toBe(before.claimed_by)
    expect(c.assignee_profile).toBe(before.assignee_profile)
    expect(after.workers.find((x) => x.id === w.id)!.card_id).toBe(w.card_id)

    // the selector's Assign is what sends a command, and that command is assign only, with the chosen profile
    const r = await api.command({ type: 'assign', card_id: target.id, profile: 'reviewer' })
    expect(r.ok).toBe(true)
    expect(sent.map((x) => x.type)).toEqual(['assign'])
    const done = findCard(applySnapshot(await api.snapshot()).snap, target.id)!
    expect(done.claimed_by).toBe(before.claimed_by) // assign does not claim, in the fixture
  })
  it('a drop on a card that no longer exists opens nothing', () => {
    const snap = applySnapshot(buildFixture()).snap
    expect(dropUi({ cardId: 'gone:t9', workerId: snap.workers[0].id, seq: 1 }, snap)).toBeNull()
  })
})
