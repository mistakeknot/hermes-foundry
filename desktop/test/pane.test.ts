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

/** Picking a profile is the only thing allowed to send, and it sends `assign`: proves the spy would see a command. */
async function pressAssign(profile: string) {
  await act(async () => { (document.getElementById(profile === FIRST ? 'foundry-profile' : `foundry-profile-${profile}`) as HTMLButtonElement).click() })
}
let FIRST = ''
const profileButtons = () => Array.from(document.querySelectorAll('[aria-label="Assign profile"] button')) as HTMLButtonElement[]

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
    FIRST = profileButtons()[0].textContent!

    // control: picking a profile is what sends, and only `assign`
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

    FIRST = profileButtons()[0].textContent!
    // control: picking a profile posts exactly one `assign`
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

describe('operating a card: one click picks a status or a profile', () => {
  const liveRest = (snap: Snapshot, posts: { path: string; body: unknown }[], reply: (body: any) => any = () => ({ ok: true })): Rest => async (path, opts) => {
    if (opts?.method && opts.method !== 'GET') { posts.push({ path, body: opts.body }); return reply(opts.body) }
    if (path.startsWith('/snapshot')) return snap
    if (path.startsWith('/events')) return { v: 1, epoch: snap.epoch, cursor: snap.cursor, events: [], resync: false }
    throw new Error('unexpected ' + path)
  }
  const click = (id: string) => act(async () => { (document.getElementById(id) as HTMLButtonElement).click() })
  const notice = () => document.getElementById('foundry-notice')?.textContent ?? ''
  async function openCard(scene: any, snap: Snapshot) {
    const card = snap.projects.flatMap((p) => p.cards).find((c) => c.claimed_by === null && !['review', 'done', 'blocked'].includes(c.status_native))!
    await dragOnto(scene, snap.workers[0].id, card.id)
    await waitFor(() => !!document.getElementById('foundry-profile'), 'the card panel')
    return card
  }

  it('a status button sends one set_status; the current status sends nothing', async () => {
    const snap: Snapshot = { ...buildFixture(), mode: 'live' }
    const posts: { path: string; body: unknown }[] = []
    const scene = await mount(liveRest(snap, posts))
    await waitFor(() => !document.getElementById('foundry-simulated') && !!document.querySelector('canvas'), 'the live pane')
    await tick(60)
    const card = await openCard(scene, snap)
    await click(`foundry-status-${card.status_native}`) // the current one: marked, inert
    expect(posts).toEqual([])
    expect((document.getElementById(`foundry-status-${card.status_native}`) as HTMLElement).getAttribute('aria-pressed')).toBe('true')
    await click('foundry-status-blocked')
    expect(posts).toEqual([{ path: '/command', body: { type: 'set_status', card_id: card.id, status_native: 'blocked' } }])
    expect(notice()).toBe('Moved to blocked')
  })

  it('a refused done shows its reason at once, as an error', async () => {
    const snap: Snapshot = { ...buildFixture(), mode: 'live' }
    const reason = 'completion blocked: b:t1 has no result or summary evidence, and Foundry cannot write one.'
    const posts: { path: string; body: unknown }[] = []
    const scene = await mount(liveRest(snap, posts, () => ({ ok: false, error: reason })))
    await waitFor(() => !document.getElementById('foundry-simulated') && !!document.querySelector('canvas'), 'the live pane')
    await tick(60)
    await openCard(scene, snap)
    const t0 = Date.now()
    await click('foundry-status-done')
    expect(Date.now() - t0).toBeLessThan(2000) // not the 8 s ack timeout
    expect(notice()).toBe(reason)
    expect((document.getElementById('foundry-notice') as HTMLElement).style.border).toContain('solid')
  })

  it('a profile button sends one assign; live wording says Hermes may start it; the current profile sends nothing', async () => {
    const snap: Snapshot = { ...buildFixture(), mode: 'live' }
    const posts: { path: string; body: unknown }[] = []
    const scene = await mount(liveRest(snap, posts))
    await waitFor(() => !document.getElementById('foundry-simulated') && !!document.querySelector('canvas'), 'the live pane')
    await tick(60)
    const card = await openCard(scene, snap)
    const names = profileButtons().map((b) => b.textContent!)
    expect(names.length).toBeGreaterThan(0)
    const current = profileButtons().find((b) => b.getAttribute('aria-pressed') === 'true')
    if (current) { await act(async () => current.click()); expect(posts).toEqual([]) }
    const other = profileButtons().find((b) => b.getAttribute('aria-pressed') !== 'true')!
    await act(async () => other.click())
    expect(posts).toEqual([{ path: '/command', body: { type: 'assign', card_id: card.id, profile: other.textContent } }])
    expect(notice()).toContain('does not claim or start the card')
    expect(notice()).toContain('Hermes may start it once assigned')
  })

  it('fixture mode keeps its own wording', async () => {
    const scene = await mount(() => Promise.reject(new Error('no router')))
    await waitFor(() => !!document.getElementById('foundry-simulated'), 'the fixture snapshot')
    const fx = await new MockApi(Date.now, 3_600_000).snapshot()
    const card = fx.projects.flatMap((p) => p.cards).find((c) => c.claimed_by === null)!
    await dragOnto(scene, fx.workers[0].id, card.id)
    await waitFor(() => !!document.getElementById('foundry-profile'), 'the card panel')
    await act(async () => profileButtons().find((b) => b.getAttribute('aria-pressed') !== 'true')!.click())
    expect(notice()).toContain('(does not start work)')
  })

  it('with no profile known on a live board, the typed field and Assign button remain', async () => {
    const snap: Snapshot = { ...buildFixture(), mode: 'live' }
    snap.projects = snap.projects.map((p) => ({ ...p, cards: p.cards.map((c) => ({ ...c, assignee_profile: null })) }))
    const posts: { path: string; body: unknown }[] = []
    const scene = await mount(liveRest(snap, posts))
    await waitFor(() => !document.getElementById('foundry-simulated') && !!document.querySelector('canvas'), 'the live pane')
    await tick(60)
    const card = await openCard(scene, snap)
    const input = document.getElementById('foundry-profile') as HTMLInputElement
    expect(input.tagName).toBe('INPUT')
    expect((document.getElementById('foundry-assign') as HTMLButtonElement).disabled).toBe(true)
    expect(posts).toEqual([])
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(input, 'coder'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await click('foundry-assign')
    expect(posts).toEqual([{ path: '/command', body: { type: 'assign', card_id: card.id, profile: 'coder' } }])
  })

  it('on a live board with profiles in use, a new profile name can still be typed and assigned (assign only)', async () => {
    const snap: Snapshot = { ...buildFixture(), mode: 'live' }
    const posts: { path: string; body: unknown }[] = []
    const scene = await mount(liveRest(snap, posts))
    await waitFor(() => !document.getElementById('foundry-simulated') && !!document.querySelector('canvas'), 'the live pane')
    await tick(60)
    const card = await openCard(scene, snap)
    expect(profileButtons().length).toBeGreaterThan(0) // buttons for the profiles already in use...
    const input = document.getElementById('foundry-profile-new') as HTMLInputElement // ...and the field beside them
    expect(input.tagName).toBe('INPUT')
    expect((document.getElementById('foundry-assign') as HTMLButtonElement).disabled).toBe(true)
    expect(posts).toEqual([])
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(input, 'brand-new-profile'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await click('foundry-assign')
    expect(posts).toEqual([{ path: '/command', body: { type: 'assign', card_id: card.id, profile: 'brand-new-profile' } }])
    expect(notice()).toContain('Foundry does not claim or start the card')
  })

  it('the fixture offers the profile buttons only, no free-text field', async () => {
    const scene = await mount(() => Promise.reject(new Error('no router')))
    await waitFor(() => !!document.getElementById('foundry-simulated'), 'the fixture snapshot')
    const fx = await new MockApi(Date.now, 3_600_000).snapshot()
    const card = fx.projects.flatMap((p) => p.cards).find((c) => c.claimed_by === null)!
    await dragOnto(scene, fx.workers[0].id, card.id)
    await waitFor(() => !!document.getElementById('foundry-profile'), 'the card panel')
    expect(document.getElementById('foundry-profile-new')).toBeNull()
    expect(document.getElementById('foundry-assign')).toBeNull()
  })

  /** a live router whose command answers are held until released, and whose event stream shows the change only once `applied` */
  function heldRest(snap: Snapshot, posts: any[], applyTo: (c: any, body: any) => any) {
    let release!: (r: { ok: boolean; error?: string }) => void
    const pending = new Promise<{ ok: boolean; error?: string }>((r) => { release = r })
    let upsert: any = null
    const rest: Rest = async (path, opts) => {
      if (opts?.method && opts.method !== 'GET') {
        posts.push(opts.body)
        const r = await pending
        if (r.ok) upsert = applyTo(snap.projects.flatMap((p) => p.cards).find((c) => c.id === (opts.body as any).card_id), opts.body)
        return r
      }
      if (path.startsWith('/snapshot')) return snap
      if (path.startsWith('/events')) {
        return { v: 1, epoch: snap.epoch, cursor: snap.cursor, resync: false,
          events: upsert ? [{ seq: 1_000_000, type: 'card_upsert', payload: { card: upsert } }] : [] }
      }
      throw new Error('unexpected ' + path)
    }
    return { rest, release: (r: { ok: boolean; error?: string }) => release(r) }
  }
  const choiceButtons = () => Array.from(document.querySelectorAll('[aria-label="Set status"] button, [aria-label="Assign profile"] button')) as HTMLButtonElement[]

  it('rapid clicks send one command; choices stay disabled until the board shows the change', async () => {
    const snap: Snapshot = { ...buildFixture(), mode: 'live' }
    const posts: any[] = []
    const held = heldRest(snap, posts, (c, body) => ({ ...c, status_native: body.status_native }))
    const scene = await mount(held.rest)
    await waitFor(() => !document.getElementById('foundry-simulated') && !!document.querySelector('canvas'), 'the live pane')
    await tick(60)
    const card = await openCard(scene, snap)
    // three clicks in one task: a double click, then a different status and a profile, before any response
    await act(async () => {
      (document.getElementById('foundry-status-blocked') as HTMLButtonElement).click()
      ;(document.getElementById('foundry-status-blocked') as HTMLButtonElement).click()
      ;(document.getElementById('foundry-status-review') as HTMLButtonElement).click()
      const other = profileButtons().find((b) => b.getAttribute('aria-pressed') !== 'true')
      other?.click()
    })
    expect(posts).toEqual([{ type: 'set_status', card_id: card.id, status_native: 'blocked' }])
    expect(choiceButtons().length).toBeGreaterThan(0)
    expect(choiceButtons().every((b) => b.disabled)).toBe(true)
    await act(async () => { held.release({ ok: true }) })
    await tick(30)
    // answered, but the card on the board has not changed yet (or had not when the guard was armed): the poll decides
    await waitFor(() => (document.getElementById('foundry-status-blocked') as HTMLElement).getAttribute('aria-pressed') === 'true', 'the board to show the new status')
    await waitFor(() => choiceButtons().every((b) => !b.disabled), 'the choices to re-enable')
    expect(posts.length).toBe(1)
  })

  it('a failed command re-enables the choices at once, so the user can retry', async () => {
    const snap: Snapshot = { ...buildFixture(), mode: 'live' }
    const posts: any[] = []
    const held = heldRest(snap, posts, (c) => c)
    const scene = await mount(held.rest)
    await waitFor(() => !document.getElementById('foundry-simulated') && !!document.querySelector('canvas'), 'the live pane')
    await tick(60)
    await openCard(scene, snap)
    await click('foundry-status-blocked')
    expect(choiceButtons().every((b) => b.disabled)).toBe(true)
    await act(async () => { held.release({ ok: false, error: 'nope' }) })
    await waitFor(() => notice() === 'nope', 'the error notice')
    expect(choiceButtons().filter((b) => b.getAttribute('aria-pressed') !== 'true').every((b) => !b.disabled)).toBe(true)
  })

  it('text typed for one card never assigns another: switching cards clears the typed profile', async () => {
    const snap: Snapshot = { ...buildFixture(), mode: 'live' }
    snap.projects = snap.projects.map((p) => ({ ...p, cards: p.cards.map((c) => ({ ...c, assignee_profile: null })) }))
    const posts: { path: string; body: unknown }[] = []
    const scene = await mount(liveRest(snap, posts))
    await waitFor(() => !document.getElementById('foundry-simulated') && !!document.querySelector('canvas'), 'the live pane')
    await tick(60)
    const [a, b] = snap.projects.flatMap((p) => p.cards).filter((c) => c.claimed_by === null && !['review', 'done', 'blocked'].includes(c.status_native))
    expect(b).toBeTruthy()
    await dragOnto(scene, snap.workers[0].id, a.id)
    await waitFor(() => !!document.getElementById('foundry-profile'), 'card A')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    const input = document.getElementById('foundry-profile') as HTMLInputElement
    await act(async () => { setter.call(input, 'coder'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    expect((document.getElementById('foundry-assign') as HTMLButtonElement).disabled).toBe(false)
    await dragOnto(scene, snap.workers[0].id, b.id)
    await waitFor(() => document.body.textContent!.includes(b.id), 'card B')
    expect((document.getElementById('foundry-profile') as HTMLInputElement).value).toBe('')
    expect((document.getElementById('foundry-assign') as HTMLButtonElement).disabled).toBe(true)
    await click('foundry-assign')
    expect(posts).toEqual([])
  })

})

describe('short pane: the Comment box', () => {
  async function dockWithPaneHeight(h: number) {
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => h })
    try {
      const fx = await new MockApi(Date.now, 3_600_000).snapshot()
      const card = fx.projects.flatMap((p) => p.cards).find((c) => c.claimed_by === null)!
      const scene = await mount(() => Promise.reject(new Error('no router')))
      await waitFor(() => !!document.getElementById('foundry-simulated'), 'the fixture snapshot')
      await dragOnto(scene, fx.workers[0].id, card.id)
      await waitFor(() => !!document.getElementById('foundry-comment-dock'), 'the card panel')
      return document.getElementById('foundry-comment-dock') as HTMLElement
    } finally {
      if (desc) Object.defineProperty(HTMLElement.prototype, 'clientHeight', desc)
      else delete (HTMLElement.prototype as any).clientHeight
    }
  }
  it('stays pinned to the bottom of the panel in a tall pane (a 600 px window and up)', async () => {
    expect((await dockWithPaneHeight(536)).style.position).toBe('sticky')
  })
  it('flows with the card in the 800x520 window (a 456 px pane), so the Assign profile row is not behind it at first glance', async () => {
    expect((await dockWithPaneHeight(456)).style.position).not.toBe('sticky')
  })
  it('flows with the card in a 420 px pane too (the 560x420 window)', async () => {
    expect((await dockWithPaneHeight(420)).style.position).not.toBe('sticky')
  })
  it('flows with the card in a pane under 500 px high, so it cannot cover the profile and status rows', async () => {
    expect((await dockWithPaneHeight(376)).style.position).not.toBe('sticky')
  })
})

describe('sound cues in the pane', () => {
  function stubAudio() {
    const made: any[] = []
    const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} })
    ;(globalThis as any).AudioContext = class {
      currentTime = 0; destination = {}; state = 'running'; oscs = 0
      constructor() { made.push(this) }
      createOscillator() { this.oscs++; return { type: '', frequency: param(), connect() {}, disconnect() {}, start() {}, stop() {}, onended: null } }
      createGain() { return { gain: param(), connect() {}, disconnect() {} } }
      resume() { return Promise.resolve() }
      close() { (this as any).closed = true; return Promise.resolve() }
    }
    return made
  }
  const store: Record<string, string> = {}
  beforeAll(() => {
    ;(globalThis as any).localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v }, removeItem: (k: string) => { delete store[k] } }
  })
  afterEach(() => { delete (globalThis as any).AudioContext; for (const k of Object.keys(store)) delete store[k] })
  const oscTotal = (made: any[]) => made.reduce((n, c) => n + c.oscs, 0)
  /** the first pointer gesture in the pane (what a real click or tap is): activates a restored "on" */
  const gesture = () => act(async () => { document.getElementById('foundry-sound')!.dispatchEvent(new Event('pointerdown', { bubbles: true })) })

  it('is off by default (no AudioContext made); the toggle turns it on, and a successful assign then plays a cue', async () => {
    const made = stubAudio()
    const fx = await new MockApi(Date.now, 3_600_000).snapshot()
    const card = fx.projects.flatMap((p) => p.cards).find((c) => c.claimed_by === null)!
    const scene = await mount(() => Promise.reject(new Error('no router')))
    await waitFor(() => !!document.getElementById('foundry-simulated'), 'the fixture snapshot')
    const btn = document.getElementById('foundry-sound') as HTMLButtonElement
    expect(btn.textContent).toBe('sound off')
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    expect(made.length).toBe(0)

    await act(async () => { btn.click() })
    expect(btn.textContent).toBe('sound on')
    expect(made.length).toBe(1)
    expect(store['foundry.sound']).toBe('1')
    const before = made[0].oscs
    await dragOnto(scene, fx.workers[0].id, card.id)
    await waitFor(() => !!document.getElementById('foundry-profile'), 'the card panel')
    FIRST = profileButtons()[0].textContent!
    expect(made[0].oscs).toBe(before) // opening the selector is silent
    await pressAssign('reviewer')
    await tick()
    expect(made[0].oscs).toBeGreaterThan(before) // the successful assign sounds

    await act(async () => { root!.unmount() }); root = null
    expect(made[0].closed).toBe(true)
  })

  it('plays the stand cue when Stand is pressed on a worker', async () => {
    const made = stubAudio()
    store['foundry.sound'] = '1'
    const fx = await new MockApi(Date.now, 3_600_000).snapshot()
    const scene = await mount(() => Promise.reject(new Error('no router')))
    await waitFor(() => !!document.getElementById('foundry-simulated'), 'the fixture snapshot')
    expect((document.getElementById('foundry-sound') as HTMLButtonElement).textContent).toBe('sound on') // the stored choice is honoured
    await act(async () => { scene.cb.onPick({ kind: 'worker', id: fx.workers[0].id }) })
    const stand = () => Array.from(document.querySelectorAll('#foundry-panel button')).find((b) => b.textContent === 'Stand') as HTMLButtonElement | undefined
    await waitFor(() => !!stand(), 'the Stand button')
    expect(made.length).toBe(0) // a restored "on" makes no context until a gesture
    await gesture()
    expect(made.length).toBe(1)
    const before = oscTotal(made)
    await act(async () => { stand()!.click() })
    await tick()
    expect(oscTotal(made)).toBeGreaterThan(before)
  })

  it('a restored "on" is silent until the first gesture: an automatic cue before it makes no context', async () => {
    const made = stubAudio()
    store['foundry.sound'] = '1'
    const fx = await new MockApi(Date.now, 3_600_000).snapshot()
    const scene = await mount(() => Promise.reject(new Error('no router')))
    await waitFor(() => !!document.getElementById('foundry-simulated'), 'the fixture snapshot')
    // a keyboard-less, pointer-less run: the command path (assign) completes with no gesture in the pane
    const card = fx.projects.flatMap((p) => p.cards).find((c) => c.claimed_by === null)!
    await dragOnto(scene, fx.workers[0].id, card.id) // dragOnto dispatches on the canvas, but not a pointerdown on the pane root chain we count
    made.length = 0
    await waitFor(() => !!document.getElementById('foundry-profile'), 'the card panel')
    FIRST = profileButtons()[0].textContent!
    await pressAssign('reviewer')                  // the click itself is not a pointerdown, so no activation
    await tick()
    expect(made.length).toBe(0)
    expect((document.getElementById('foundry-sound') as HTMLButtonElement).textContent).toBe('sound on')
  })

  it('a command that completes after the pane unmounts never sounds or opens a context', async () => {
    const made = stubAudio()
    store['foundry.sound'] = '1'
    const snap: Snapshot = { ...buildFixture(), mode: 'live' }
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const posts: unknown[] = []
    const rest: Rest = async (path, opts) => {
      if (opts?.method && opts.method !== 'GET') { posts.push(opts.body); await gate; return { ok: true } }
      if (path.startsWith('/snapshot')) return snap
      if (path.startsWith('/events')) return { v: 1, epoch: snap.epoch, cursor: snap.cursor, events: [], resync: false }
      return {}
    }
    const scene = await mount(rest)
    await waitFor(() => !document.getElementById('foundry-simulated') && !!document.querySelector('canvas'), 'the live pane')
    await tick(60)
    await gesture()
    expect(made.length).toBe(1)
    const card = snap.projects.flatMap((p) => p.cards).find((c) => c.claimed_by === null)!
    await dragOnto(scene, snap.workers[0].id, card.id)
    await waitFor(() => !!document.getElementById('foundry-profile'), 'the card panel')
    await tick()
    FIRST = profileButtons()[0].textContent!
    await pressAssign('reviewer')                  // the POST is now pending
    expect(posts).toHaveLength(1)
    const n = oscTotal(made)
    await act(async () => { root!.unmount() }); root = null
    expect(made[0].closed).toBe(true)
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 30)) }) // the command completes after unmount
    expect(made.length).toBe(1)                    // no second context
    expect(oscTotal(made)).toBe(n)                 // and no sound
  })

  it('the slip cue fires once per slip edge, not on every frame, and never for a non-looping climber', async () => {
    const made = stubAudio()
    store['foundry.sound'] = '1'
    const scene = await mount(() => Promise.reject(new Error('no router')))
    await waitFor(() => !!document.getElementById('foundry-simulated'), 'the fixture snapshot')
    await tick(60)
    for (let i = 0; i < 40; i++) scene.animateClimbers(i, 1)   // everyone arrives
    await gesture()
    const looping = [...scene.climbers.values()].filter((c: any) => c.worker.state === 'looping')[0] as any
    const base = -looping.phase / (2 * Math.PI) * 4
    const slide = base + 4 * 0.84, struggle = base + 4 * 0.3
    scene.animateClimbers(struggle, 0)              // sitting level: silent
    const o0 = oscTotal(made)
    scene.animateClimbers(slide, 0)                 // the edge: one slip cue
    const o1 = oscTotal(made)
    expect(o1).toBeGreaterThan(o0)
    for (let i = 0; i < 5; i++) scene.animateClimbers(slide + i * 0.01, 0) // still sliding: no retrigger
    expect(oscTotal(made)).toBe(o1)
  })

  it('plays the blocked cue only when a card newly becomes blocked, never on first load', async () => {
    const made = stubAudio()
    store['foundry.sound'] = '1'
    const base = await new MockApi(Date.now, 3_600_000).snapshot()
    const snap = { ...base, mode: 'live' as const, last_seq: 5, cursor: '5' }
    const victim = snap.projects.flatMap((p) => p.cards).find((c) => c.status !== 'blocked')!
    let phase = 0
    const rest: Rest = async (path) => {
      if (path.startsWith('/snapshot')) return snap
      if (path.startsWith('/events')) {
        const events = phase === 1 ? [{ seq: 6, ts: 't', type: 'card_upsert', payload: { card: { ...victim, status: 'blocked', status_native: 'blocked' } } }] : []
        const r = { v: 1, epoch: snap.epoch, cursor: phase === 1 ? '6' : '5', events, resync: false }
        if (phase === 1) phase = 2
        return r
      }
      return {}
    }
    await mount(rest)
    await waitFor(() => !document.getElementById('foundry-simulated') && !!document.getElementById('foundry-sound'), 'the live pane')
    expect((document.getElementById('foundry-sound') as HTMLButtonElement).textContent).toBe('sound on')
    await gesture()
    expect(made.length).toBe(1)
    expect(oscTotal(made)).toBe(0) // blocked cards already on the board make no sound at first load
    phase = 1
    // live polling runs every 2 s, longer than waitFor's window
    for (let i = 0; i < 250 && oscTotal(made) === 0; i++) await tick()
    const first = oscTotal(made)
    expect(first).toBeGreaterThan(0)
    expect(phase).toBe(2)
    // the card stays blocked: re-renders (a pick) and later polls are silent
    await act(async () => { document.getElementById('foundry-sound')!.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
    await tick(2200)
    expect(oscTotal(made)).toBe(first)
  }, 20000)
})
