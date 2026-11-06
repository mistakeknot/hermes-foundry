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
import { buildFixture } from '../src/mock'
import { applySnapshot } from '../src/reducer'
import type { Snapshot } from '../src/types'

function fakeCanvas() {
  return { style: {}, addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }), clientWidth: 800, clientHeight: 600, ownerDocument: { addEventListener() {}, removeEventListener() {} }, getRootNode: () => ({ addEventListener() {}, removeEventListener() {} }), setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false } as unknown as HTMLCanvasElement
}
const noop = { onPick() {}, onHover() {} }
const mk = () => new FoundryScene(fakeCanvas(), { appendChild() {} } as unknown as HTMLElement, noop)
const near = (a: THREE.Vector3, b: THREE.Vector3) => a.distanceTo(b) < 1e-6

beforeAll(() => {
  const g = globalThis as Record<string, unknown>
  g.document = { createElement: () => ({ style: {}, remove() {}, textContent: '' }) }
  g.requestAnimationFrame = () => 0
  g.cancelAnimationFrame = () => {}
})

function snapWith(extra: boolean): Snapshot {
  const s = applySnapshot(buildFixture()).snap
  if (extra) {
    // a project that sorts first, so every existing creature's slot moves
    const p = structuredClone(s.projects[0])
    p.id = 'aaa'; p.name = 'Added'
    for (const c of p.cards) { c.id = c.id.replace(/^[^:]+:/, 'aaa:'); c.claimed_by = null }
    p.epics.forEach((e) => { e.id = e.id.replace(/^[^:]+:/, 'aaa:') })
    p.cards.forEach((c) => { if (c.epic_id) c.epic_id = c.epic_id.replace(/^[^:]+:/, 'aaa:') })
    s.projects.unshift(p)
  }
  return s
}

describe('relayout keeps world coordinates attached to cards', () => {
  it('after adding a project, climbers, beacons and the selection sit on the same cards as a fresh scene', () => {
    const before = snapWith(false), after = snapWith(true)
    const inc = mk() as any, fresh = mk() as any
    inc.update(before)
    const held = before.workers.find((w) => w.card_id)!
    inc.select(held.card_id)
    inc.update(after)
    fresh.update(after)
    // every card position equals a scene built from scratch
    let n = 0
    for (const p of after.projects) for (const c of p.cards) { expect(near(inc.cardWorldPos(c.id), fresh.cardWorldPos(c.id))).toBe(true); n++ }
    expect(n).toBeGreaterThan(10)
    // the creature moved (otherwise this test would prove nothing)
    expect(inc.creatures.get(before.projects[0].id).center.distanceTo(new THREE.Vector3(0, 0, 0)) >= 0).toBe(true)
    // climbers target their card
    for (const c of inc.climbers.values()) if (c.cardId) expect(near(c.target, inc.cardWorldPos(c.cardId))).toBe(true)
    // beacons hover over their card
    expect(inc.beacons.length).toBeGreaterThan(0)
    for (const b of inc.beacons) expect(near(b.mesh.position, inc.cardWorldPos(b.cardId).clone().add(new THREE.Vector3(0, 1, 0)))).toBe(true)
    // selection ring follows the card
    expect(near(inc.selection.position, inc.cardWorldPos(held.card_id!).clone().add(new THREE.Vector3(0, 0.15, 0)))).toBe(true)
    // labels moved with their creature
    for (const [id, v] of inc.creatures) {
      const f = fresh.creatures.get(id)
      v.labels.forEach((l: any, i: number) => expect(near(l.world, f.labels[i].world)).toBe(true))
      expect(near(v.center, f.center)).toBe(true)
    }
    inc.dispose(); fresh.dispose()
  })

  it('moved a creature in the first place', () => {
    const s = mk() as any
    s.update(snapWith(false))
    const id = snapWith(false).projects[0].id
    const c0 = s.creatures.get(id).center.clone()
    s.update(snapWith(true))
    expect(s.creatures.get(id).center.distanceTo(c0)).toBeGreaterThan(0.01)
    s.dispose()
  })
})

describe('claim rings', () => {
  it('a secondary claim by a known worker shows a ring; the climbed card and a missing worker do not', () => {
    const snap = snapWith(false)
    const w = snap.workers[0]
    const cards = snap.projects[0].cards
    cards[0].claimed_by = w.id; cards[0].updated_at = '2026-11-07T10:00:00Z'
    cards[1].claimed_by = w.id; cards[1].updated_at = '2026-11-07T09:00:00Z' // older: secondary
    cards[2].claimed_by = 'gone'
    const s = mk() as any
    s.update(applySnapshot(snap).snap)
    const v = s.creatures.get(snap.projects[0].id)
    const shown = (cardId: string) => {
      const i = v.scaleIds.indexOf(cardId)
      if (i < 0) return null
      const m = new THREE.Matrix4(); v.claims.getMatrixAt(i, m)
      return m.getMaxScaleOnAxis() > 0
    }
    expect(shown(cards[0].id)).toBe(false)
    expect(shown(cards[1].id)).toBe(true)
    expect(shown(cards[2].id)).toBe(false)
    s.dispose()
  })
})
