// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

const state = vi.hoisted(() => ({ sidebar: { status: 'loading' } as Record<string, unknown>, registers: 0, lastRest: null as unknown }))
vi.mock('@get-bb/plugin-sdk/app', () => ({ experimental_useSidebarThreads: () => state.sidebar }))
vi.mock('../../desktop/src/plugin', () => ({
  default: {
    register: (ctx: { rest: unknown; register: (c: { id: string; render: () => unknown }) => void }) => {
      state.registers++
      state.lastRest = ctx.rest
      ctx.register({ id: 'page', render: () => 'PANE' })
    },
  },
}))

import { FoundryPanel, THEME_ALIASES } from '../src/panel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ready = (title: string) => ({
  status: 'ready',
  projects: [{ id: 'p1', name: 'Alpha' }],
  sections: [],
  threads: [{ id: 't1', projectId: 'p1', displayTitle: title, sectionId: null, providerId: 'x', status: 'idle', hasPendingInteraction: false, isUnread: false, isArchived: false, isHidden: false, updatedAt: Date.now() }],
})

describe('FoundryPanel lifecycle', () => {
  let host: HTMLDivElement
  let root: Root
  const paint = () => act(() => { root.render(createElement(FoundryPanel)) })

  beforeEach(() => {
    state.sidebar = { status: 'loading' }
    state.registers = 0
    host = document.createElement('div')
    root = createRoot(host)
  })
  afterEach(() => { act(() => root.unmount()); vi.useRealTimers() })

  it('lays the pane out below the host chrome row, in the flow, not against the window', () => {
    state.sidebar = ready('First')
    paint()
    const outer = host.firstElementChild as HTMLElement
    expect(outer.style.paddingTop).toContain('--bb-app-chrome-row-height')
    expect(outer.style.position).not.toBe('absolute')
    const wrapper = outer.firstElementChild as HTMLElement
    expect(wrapper.style.position).toBe('relative')
    expect((wrapper.firstElementChild as HTMLElement).style.position).toBe('absolute')
  })

  it('aliases the pane\'s theme variables to bb\'s on the wrapper and uses bb colors for the stale banner', () => {
    state.sidebar = ready('First')
    paint()
    const outer = host.firstElementChild as HTMLElement
    for (const [k, v] of Object.entries(THEME_ALIASES)) expect(outer.style.getPropertyValue(k)).toBe(v)
    expect(THEME_ALIASES['--dt-background']).toBe('var(--background)')
    state.sidebar = { ...ready('First'), status: 'error' }
    paint()
    expect(host.innerHTML).not.toContain('rgba(0, 0, 0')
  })

  it('does not mount the pane when the thread list fails first, and mounts it live after recovery', async () => {
    state.sidebar = { status: 'error' }
    paint()
    expect(state.registers).toBe(0)
    expect(host.textContent).toContain("Couldn't load threads")
    state.sidebar = ready('First')
    paint()
    expect(state.registers).toBe(1)
    expect(host.textContent).toContain('PANE')
    const get = state.lastRest as (path: string) => Promise<{ projects: { cards: { title: string }[] }[] }>
    const snap = await get('/snapshot')
    expect(snap.projects[0].cards[0].title).toBe('First')
  })

  it('keeps the last board and says it may be out of date when the list fails later, then clears on recovery', () => {
    state.sidebar = ready('First')
    paint()
    state.sidebar = { status: 'error' }
    paint()
    expect(host.textContent).toContain('PANE')
    expect(host.textContent).toContain('Thread list unavailable')
    state.sidebar = ready('First')
    paint()
    expect(host.textContent).not.toContain('Thread list unavailable')
    expect(state.registers).toBe(1)
  })

  it('puts the Foundry pane to the right of the board, in the same row, only once there is data', () => {
    state.sidebar = { status: 'loading' }
    paint()
    expect(host.querySelector('[data-foundry=pane]')).toBeNull()
    state.sidebar = ready('First')
    paint()
    const outer = host.firstElementChild as HTMLElement
    expect(outer.style.flexDirection).toBe('row')
    expect([...outer.children].map((c) => c.getAttribute('data-foundry'))).toEqual([null, 'pane'])
    expect((outer.lastElementChild as HTMLElement).style.width).toBe('22%')
  })

  it('opens the drawer for a creature, and keeps the outline (and drawer) when the list fails later', () => {
    state.sidebar = ready('First')
    paint()
    const alpha = [...host.querySelectorAll<HTMLElement>('[data-foundry=creature]')].find((e) => e.textContent === 'Alpha')!
    act(() => { alpha.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(host.querySelector('[data-foundry=drawer]')).not.toBeNull()
    state.sidebar = { status: 'error' }
    paint()
    expect(host.querySelector('[data-foundry=drawer]')).not.toBeNull()
  })

  it('closes the drawer when the selected creature leaves the thread list', () => {
    state.sidebar = ready('First')
    paint()
    const alpha = [...host.querySelectorAll<HTMLElement>('[data-foundry=creature]')].find((e) => e.textContent === 'Alpha')!
    act(() => { alpha.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    state.sidebar = { ...ready('First'), projects: [{ id: 'p2', name: 'Beta' }], threads: [] }
    paint()
    expect(host.querySelector('[data-foundry=drawer]')).toBeNull()
  })

  it('re-reads the clock on a timer, so an idle card turns done without any sidebar update', async () => {
    vi.useFakeTimers()
    const t0 = new Date('2026-11-06T12:00:00Z').getTime()
    vi.setSystemTime(t0)
    const s = ready('Old') as ReturnType<typeof ready>
    s.threads[0].updatedAt = t0
    state.sidebar = s
    paint()
    const get = state.lastRest as (path: string) => Promise<{ projects: { cards: { status: string }[] }[] }>
    expect((await get('/snapshot')).projects[0].cards[0].status).toBe('open')
    vi.setSystemTime(t0 + 25 * 3600 * 1000)
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect((await get('/snapshot')).projects[0].cards[0].status).toBe('done')
  })
})
