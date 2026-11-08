import { beforeAll, describe, expect, it, vi } from 'vitest'

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

function fakeCanvas(vars: Record<string, string> = {}) {
  return { style: {}, __vars: vars, addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }), clientWidth: 800, clientHeight: 600, ownerDocument: { addEventListener() {}, removeEventListener() {} }, getRootNode: () => ({ addEventListener() {}, removeEventListener() {} }), setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false } as unknown as HTMLCanvasElement
}
const mk = (vars?: Record<string, string>) => new FoundryScene(fakeCanvas(vars), { appendChild() {} } as unknown as HTMLElement, { onPick() {}, onHover() {} })

beforeAll(() => {
  const g = globalThis as Record<string, unknown>
  g.document = { createElement: () => ({ style: {}, remove() {}, textContent: '' }) }
  g.requestAnimationFrame = () => 0
  g.cancelAnimationFrame = () => {}
  g.getComputedStyle = (el: { __vars?: Record<string, string> }) => ({ getPropertyValue: (n: string) => el.__vars?.[n] ?? '' })
})

function manyProjects(n: number) {
  const s = applySnapshot(buildFixture()).snap
  const base = s.projects[0]
  s.projects = Array.from({ length: n }, (_, i) => {
    const p = structuredClone(base)
    const tag = `p${String(i).padStart(2, '0')}`
    p.id = tag; p.name = `Project ${i}`
    p.cards.forEach((c) => { c.id = `${tag}:${c.id}`; c.claimed_by = null; if (c.epic_id) c.epic_id = `${tag}:${c.epic_id}` })
    p.epics.forEach((e) => { e.id = `${tag}:${e.id}` })
    return p
  })
  s.workers = []
  return s
}

describe('the ground under a wide layout', () => {
  it.each([1, 3, 10, 24])('holds %i creatures on a floor that is never above their feet', (n) => {
    const sc = mk() as any
    sc.update(manyProjects(n))
    const pos = sc.ground.geometry.attributes.position
    let checked = 0
    for (const v of sc.creatures.values()) {
      const r = v.spec.radius
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), z = pos.getZ(i)
        if (Math.hypot(x - v.center.x, z - v.center.z) <= r) { expect(pos.getY(i)).toBeLessThanOrEqual(0); checked++ }
      }
    }
    expect(checked).toBeGreaterThan(0)
    sc.dispose()
  })
  it('keeps boulders off the creatures\' floor', () => {
    const sc = mk() as any
    sc.update(manyProjects(10))
    const m = new (sc.rocks.matrix.constructor)(), p = new (sc.rocks.position.constructor)()
    for (let i = 0; i < sc.rocks.count; i++) {
      sc.rocks.getMatrixAt(i, m); p.setFromMatrixPosition(m)
      for (const v of sc.creatures.values()) expect(Math.hypot(p.x - v.center.x, p.z - v.center.z)).toBeGreaterThan(v.spec.radius)
    }
    sc.dispose()
  })
  it('reshapes only when the floor radius changes', () => {
    const sc = mk() as any
    sc.update(manyProjects(6))
    const g = sc.ground
    sc.update(manyProjects(6))
    expect(sc.ground).toBe(g)
    sc.update(manyProjects(20))
    expect(sc.ground).not.toBe(g)
    sc.dispose()
  })
})

describe('the stage follows the host theme', () => {
  const bg = (sc: any) => sc.scene.background.getHex()
  it('uses the default until the host defines --dt-background, then its value, for background and fog', () => {
    const vars: Record<string, string> = {}
    const sc = mk(vars) as any
    expect(bg(sc)).toBe(0x0c1210)
    vars['--dt-background'] = '#f4f1e6'
    sc.applyTheme()
    expect(bg(sc)).toBe(0xf4f1e6)
    expect(sc.scene.fog.color.getHex()).toBe(0xf4f1e6)
    vars['--dt-background'] = 'rgb(10, 20, 30)'
    sc.applyTheme()
    expect(bg(sc)).toBe(0x0a141e)
    vars['--dt-background'] = ''
    sc.applyTheme()
    expect(bg(sc)).toBe(0x0c1210)
    sc.dispose()
  })
})
