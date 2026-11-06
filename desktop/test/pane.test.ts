// @vitest-environment jsdom
// The mounted pane: register() -> page render -> real FoundryScene on a real <canvas> -> the real onDrop callback in
// plugin.ts. A command spy sits behind the pane (MockApi.command in fixture mode, the POST /command route in live
// mode). A climber dropped on a scale must send nothing and must leave the profile field focused.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as ReactNS from 'react'
import { createRoot, type Root } from 'react-dom/client'

// src/sdk.d.ts declares only the slice of 'react' the pane uses, so act is reached untyped
const act = (ReactNS as unknown as { act: (f: () => unknown) => Promise<void> }).act

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

import plugin from '../src/plugin'
import { MockApi, buildFixture } from '../src/mock'
import type { Pick } from '../src/scene'
import type { Snapshot } from '../src/types'

beforeAll(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  ;(globalThis as any).ResizeObserver = class { observe() {} disconnect() {} unobserve() {} }
  const proto = HTMLCanvasElement.prototype as any
  proto.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 })
  proto.setPointerCapture = () => {}
  proto.releasePointerCapture = () => {}
  proto.hasPointerCapture = () => false
})

let root: Root | null = null
afterEach(async () => {
  if (root) { const r = root; await act(async () => r.unmount()); root = null }
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const tick = (ms = 20) => act(async () => { await new Promise((r) => setTimeout(r, ms)) })
async function waitFor(f: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) { if (f()) return; await tick() }
  throw new Error('timed out waiting for ' + what)
}

type Rest = (path: string, opts?: { method?: string; body?: unknown }) => Promise<any>

/** register() the plugin against a fake host and mount its page; returns the scene once the canvas is live. */
async function mount(rest: Rest) {
  let page: (() => unknown) | null = null
  const ctx = { rest, register: (c: any) => { if (c.id === 'page') page = c.render } }
  plugin.register(ctx as any)
  expect(page).not.toBeNull()
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(page!() as any) })
  await waitFor(() => !!(globalThis as any).__foundry?.scene, 'the scene')
  return (globalThis as any).__foundry.scene as any
}

/** A real press-move-release on the pane's canvas, with pickAt scripted so no WebGL is needed. */
async function dragOnto(scene: any, workerId: string, cardId: string) {
  const canvas = document.querySelector('canvas')!
  let under: Pick | null = null
  scene.pickAt = () => (under ? { pick: under, label: '' } : null)
  const fire = (type: string, x: number) => {
    const e = new MouseEvent(type, { clientX: x, clientY: 100, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true })
    Object.defineProperty(e, 'pointerId', { value: 1 })
    Object.defineProperty(e, 'pointerType', { value: 'mouse' })
    canvas.dispatchEvent(e)
  }
  await act(async () => {
    under = { kind: 'worker', id: workerId }; fire('pointerdown', 100)
    fire('pointermove', 200)
    under = { kind: 'card', id: cardId }; fire('pointermove', 300)
    fire('pointerup', 300)
  })
}

/** The Assign button is the only thing allowed to send, and it sends `assign`: proves the spy would see a command. */
async function pressAssign(profile: string) {
  const input = document.getElementById('foundry-profile') as HTMLInputElement
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { set.call(input, profile); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => { (document.getElementById('foundry-assign') as HTMLButtonElement).click() })
}

describe('fixture mode: the real onDrop callback', () => {
  it('opens the profile selector, sends no command, claims nothing', async () => {
    const spy = vi.spyOn(MockApi.prototype, 'command')
    const fx = await new MockApi(Date.now, 3_600_000).snapshot()
    const card = fx.projects.flatMap((p) => p.cards).find((c) => c.claimed_by === null)!
    const worker = fx.workers[0]

    const scene = await mount(() => Promise.reject(new Error('no router'))) // probe fails -> the in-pane fixture
    await waitFor(() => !!document.getElementById('foundry-simulated'), 'the fixture snapshot')

    await dragOnto(scene, worker.id, card.id)
    await waitFor(() => !!document.getElementById('foundry-profile'), 'the card panel')
    await tick()
    expect(spy).toHaveBeenCalledTimes(0)
    expect(document.activeElement?.id).toBe('foundry-profile')
    expect(document.body.textContent).toContain('does not claim')

    // control: the explicit Assign button is what sends, and only `assign`
    await pressAssign('reviewer')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toMatchObject({ type: 'assign', card_id: card.id, profile: 'reviewer' })
  })
  it('a drop on empty space changes nothing and sends nothing', async () => {
    const spy = vi.spyOn(MockApi.prototype, 'command')
    const scene = await mount(() => Promise.reject(new Error('no router')))
    await waitFor(() => !!document.getElementById('foundry-simulated'), 'the fixture snapshot')
    const canvas = document.querySelector('canvas')!
    let under: Pick | null = { kind: 'worker', id: 'whoever' }
    scene.pickAt = () => (under ? { pick: under, label: '' } : null)
    const fire = (type: string, x: number) => {
      const e = new MouseEvent(type, { clientX: x, clientY: 100, button: 0, buttons: 1, bubbles: true })
      Object.defineProperty(e, 'pointerId', { value: 1 })
      canvas.dispatchEvent(e)
    }
    await act(async () => { fire('pointerdown', 100); under = null; fire('pointerup', 300) })
    await tick()
    expect(spy).toHaveBeenCalledTimes(0)
    expect(document.getElementById('foundry-profile')).toBeNull()
  })
})

describe('valley frame', () => {
  it('draws a non-interactive vignette over the canvas, under the labels and header', async () => {
    await mount(() => Promise.reject(new Error('no router')))
    await waitFor(() => !!document.getElementById('foundry-simulated'), 'the fixture snapshot')
    const v = document.getElementById('foundry-vignette') as HTMLElement
    expect(v).not.toBeNull()
    expect(v.style.pointerEvents).toBe('none')
    expect(v.style.background).toContain('radial-gradient')
    // covers the whole stage: absolutely positioned, pinned to every edge (inset: 0 expands to four longhands in jsdom or stays as the shorthand)
    expect(v.style.position).toBe('absolute')
    const edges = [v.style.top, v.style.right, v.style.bottom, v.style.left]
    expect(v.style.inset === '0px' || v.style.inset === '0' || edges.every((e) => e === '0px' || e === '0')).toBe(true)

    // stacking: canvas, then vignette, then the labels layer, then the header, all siblings in the stage
    const canvas = document.querySelector('canvas')!
    const stage = v.parentElement!
    expect(canvas.parentElement).toBe(stage)
    const kids = Array.from(stage.children)
    const iCanvas = kids.indexOf(canvas), iVignette = kids.indexOf(v)
    expect(iCanvas).toBe(0)
    expect(iVignette).toBe(iCanvas + 1)
    const labels = kids[iVignette + 1] as HTMLElement // the layer the scene writes its labels into
    expect(labels.tagName).toBe('DIV')
    expect(labels.id).toBe('')
    expect(labels.style.position).toBe('absolute')
    expect(labels.style.pointerEvents).toBe('none')
    const header = kids[iVignette + 2] as HTMLElement
    expect(header.textContent).toContain('Foundry') // the title row
    expect(canvas.compareDocumentPosition(v) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(v.compareDocumentPosition(labels) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(labels.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
  it('removes the vignette and the scene with the pane', async () => {
    await mount(() => Promise.reject(new Error('no router')))
    await waitFor(() => !!document.getElementById('foundry-vignette'), 'the vignette')
    const r = root!
    root = null
    await act(async () => r.unmount())
    expect(document.getElementById('foundry-vignette')).toBeNull()
    expect(document.querySelector('canvas')).toBeNull()
  })
})

describe('live mode: the real onDrop callback', () => {
  it('opens the profile selector, POSTs nothing, claims nothing', async () => {
    const snap: Snapshot = { ...buildFixture(), mode: 'live' }
    const posts: { path: string; body: unknown }[] = []
    const rest: Rest = async (path, opts) => {
      if (opts?.method && opts.method !== 'GET') { posts.push({ path, body: opts.body }); return { ok: true } }
      if (path.startsWith('/snapshot')) return snap
      if (path.startsWith('/events')) return { v: 1, epoch: snap.epoch, cursor: snap.cursor, events: [], resync: false }
      throw new Error('unexpected ' + path)
    }
    const card = snap.projects.flatMap((p) => p.cards).find((c) => c.claimed_by === null)!
    const worker = snap.workers[0]

    const scene = await mount(rest)
    await waitFor(() => (globalThis as any).__foundry?.scene && document.body.textContent!.includes('Foundry') && !document.getElementById('foundry-simulated') && !!document.querySelector('canvas'), 'the live pane')
    await tick(60) // let the first snapshot land

    await dragOnto(scene, worker.id, card.id)
    await waitFor(() => !!document.getElementById('foundry-profile'), 'the card panel')
    await tick()
    expect(document.getElementById('foundry-simulated')).toBeNull() // really live mode
    expect(posts).toEqual([])
    expect(document.activeElement?.id).toBe('foundry-profile')

    // control: the Assign button posts exactly one `assign`
    await pressAssign('reviewer')
    expect(posts).toEqual([{ path: '/command', body: { type: 'assign', card_id: card.id, profile: 'reviewer' } }])
  })
})

describe('the slip is drawn only for a worker that reports looping', () => {
  const settle = (scene: any) => { for (let i = 0; i < 40; i++) scene.animateClimbers(i, 1) } // let every climber arrive
  const rollsAt = (scene: any, t: number) => {
    scene.animateClimbers(t, 0)
    return new Map<string, number>([...scene.climbers.values()].map((c: any) => [c.id, c.mesh.rotation.z]))
  }
  const slipTimes = (phase: number) => { // a time inside the slide and one inside the struggle, for this climber
    const base = -phase / (2 * Math.PI) * 4
    return { slide: base + 4 * 0.84, struggle: base + 4 * 0.3 }
  }

  it('fixture: the one looping climber tips while slipping and sits level while struggling; the rest never tip', async () => {
    const scene = await mount(() => Promise.reject(new Error('no router')))
    await waitFor(() => !!document.getElementById('foundry-simulated'), 'the fixture snapshot')
    await tick(60)
    settle(scene)
    const looping = [...scene.climbers.values()].filter((c: any) => c.worker.state === 'looping')
    expect(looping).toHaveLength(1)
    const lp = looping[0] as any
    const { slide, struggle } = slipTimes(lp.phase)
    const slid = rollsAt(scene, slide), still = rollsAt(scene, struggle)
    expect(Math.abs(slid.get(lp.id)!)).toBeGreaterThan(0.5)
    expect(still.get(lp.id)).toBe(0)
    for (const c of scene.climbers.values() as any) if (c.id !== lp.id) { expect(slid.get(c.id)).toBe(0); expect(still.get(c.id)).toBe(0) }
  })

  it('live: climbers the source reports as working or unknown never slip, at any time', async () => {
    const snap: Snapshot = { ...buildFixture(), mode: 'live' }
    snap.workers = snap.workers.map((w, i) => ({ ...w, state: i % 2 ? 'unknown' : 'working' }))
    const rest: Rest = async (path) => {
      if (path.startsWith('/snapshot')) return snap
      if (path.startsWith('/events')) return { v: 1, epoch: snap.epoch, cursor: snap.cursor, events: [], resync: false }
      throw new Error('unexpected ' + path)
    }
    const scene = await mount(rest)
    await waitFor(() => !document.getElementById('foundry-simulated') && scene.climbers.size === snap.workers.length, 'the live climbers')
    settle(scene)
    for (let t = 0; t < 12; t += 0.37) for (const r of rollsAt(scene, t).values()) expect(r).toBe(0)
  })
})
