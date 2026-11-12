// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

const state = vi.hoisted(() => ({ chat: 'ok' as 'ok' | 'fail', project: 'pc' as string | null | 'fail' | 'later' | 'stale', release: null as null | (() => void), projectCalls: 0, chatCalls: 0, sidebar: { status: 'loading' } as Record<string, unknown>, registers: 0, lastRest: null as unknown, handlers: new Map<string, (p: unknown) => void>(), bridge: [] as [string, unknown][], values: new Map<string, object>() }))
vi.mock('@get-bb/plugin-sdk/app', () => {
  const sdk = { threadSections: { list: async () => [] } }
  const values = state.values
  const rpc = { call: async (method: string, args: { projectId: string; patch?: object }) => {
    if (method === 'chat.project') { if (state.project === 'fail') throw new Error('lookup failed'); if (state.project === 'stale') { if (state.projectCalls++ === 0) return new Promise(res => { state.release = () => res({ projectId: null }) }); return { projectId: 'pc' } }
      if (state.project === 'later') return { projectId: state.projectCalls++ === 0 ? null : 'pc' }; return { projectId: state.project } }
    if (method === 'chat.ensure') { state.chatCalls++; if (state.chat === 'fail') throw new Error('bb said no'); return { projectId: 'pc', threadId: 'tc' } }
    if (method.startsWith('edit.')) { state.bridge.push([method, args]); return true }
    if (method === 'lineage.set') values.set(args.projectId, { ...values.get(args.projectId), ...args.patch })
    return structuredClone(values.get(args.projectId) ?? {})
  } }
  const ThreadChat = (p: { threadId: string; variant?: string }) => createElement('div', { 'data-test': 'thread-chat', 'data-thread': p.threadId, 'data-variant': p.variant })
  return { ThreadChat, experimental_useSidebarThreads: () => state.sidebar, useSdk: () => sdk, useRpc: () => rpc, useRealtime: (channel: string, h: (p: unknown) => void) => { state.handlers.set(channel, h) } }
})
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
  const paint = () => act(async () => { root.render(createElement(FoundryPanel)) })

  beforeEach(() => {
    state.sidebar = { status: 'loading' }
    state.chat = 'ok'
    state.project = 'pc'
    state.projectCalls = 0
    state.release = null
    state.chatCalls = 0
    state.registers = 0
    state.bridge = []
    state.values.clear()
    state.handlers.clear()
    host = document.createElement('div')
    root = createRoot(host)
  })
  afterEach(() => { act(() => root.unmount()); vi.useRealTimers() })

  it('embeds bb\'s chat for the Foundry thread and keeps the Foundry project out of the board', async () => {
    const sidebar = ready('First') as { projects: { id: string; name: string }[]; threads: Record<string, unknown>[] }
    sidebar.projects.push({ id: 'pc', name: 'Foundry' })
    sidebar.threads.push({ ...sidebar.threads[0], id: 'tc', projectId: 'pc', displayTitle: 'Foundry chat' })
    state.sidebar = sidebar
    await paint()
    const chat = host.querySelector<HTMLElement>('[data-test=thread-chat]')!
    expect(chat.dataset.thread).toBe('tc')
    expect(chat.dataset.variant).toBe('compact')
    expect(state.chatCalls).toBe(1)
    expect(host.querySelectorAll('[data-foundry=creature]').length).toBe(1)
  })

  it('keeps the Foundry project out of the board even when the chat thread cannot be made', async () => {
    const sidebar = ready('First') as { projects: { id: string; name: string }[]; threads: Record<string, unknown>[] }
    sidebar.projects.push({ id: 'pc', name: 'Foundry' })
    sidebar.threads.push({ ...sidebar.threads[0], id: 'tc', projectId: 'pc', displayTitle: 'Foundry chat' })
    state.sidebar = sidebar
    state.chat = 'fail'
    await paint()
    expect(host.querySelector('[data-foundry=chat-status]')!.textContent).toContain('bb said no')
    expect(host.querySelectorAll('[data-foundry=creature]').length).toBe(1)
  })

  it('looks the chat project up again when ensure fails after the first lookup saw none', async () => {
    const sidebar = ready('First') as { projects: { id: string; name: string }[]; threads: Record<string, unknown>[] }
    sidebar.projects.push({ id: 'pc', name: 'Foundry' })
    sidebar.threads.push({ ...sidebar.threads[0], id: 'tc', projectId: 'pc', displayTitle: 'Foundry chat' })
    state.sidebar = sidebar
    state.project = 'later'
    state.chat = 'fail'
    await paint()
    expect(state.projectCalls).toBe(2)
    expect(host.querySelectorAll('[data-foundry=creature]').length).toBe(1)
  })

  it('ignores a slow first lookup that answers after the recovery lookup', async () => {
    const sidebar = ready('First') as { projects: { id: string; name: string }[]; threads: Record<string, unknown>[] }
    sidebar.projects.push({ id: 'pc', name: 'Foundry' })
    sidebar.threads.push({ ...sidebar.threads[0], id: 'tc', projectId: 'pc', displayTitle: 'Foundry chat' })
    state.sidebar = sidebar
    state.project = 'stale'
    state.chat = 'fail'
    await paint()
    expect(state.projectCalls).toBe(2)
    await act(async () => { state.release!() })
    expect(host.querySelectorAll('[data-foundry=creature]').length).toBe(1)
  })

  it('shows the list unfiltered if the project lookup itself fails', async () => {
    const sidebar = ready('First') as { projects: { id: string; name: string }[]; threads: Record<string, unknown>[] }
    sidebar.projects.push({ id: 'pc', name: 'Foundry' })
    sidebar.threads.push({ ...sidebar.threads[0], id: 'tc', projectId: 'pc', displayTitle: 'Foundry chat' })
    state.sidebar = sidebar
    state.project = 'fail'
    state.chat = 'fail'
    await paint()
    expect(host.querySelectorAll('[data-foundry=creature]').length).toBe(2)
  })

  it('says so, and keeps the placeholder, when the Foundry chat cannot be opened', async () => {
    state.sidebar = ready('First')
    state.chat = 'fail'
    await paint()
    expect(host.querySelector('[data-test=thread-chat]')).toBeNull()
    expect(host.querySelector('[data-foundry=chat-status]')!.textContent).toContain('bb said no')
    expect(host.querySelector('[data-foundry=thread]')).not.toBeNull()
  })

  it('gives a fake thread caller shared edits, visible form history, and one-step undo', async () => {
    state.sidebar = ready('First')
    const Thread: import('../src/thread-port').ThreadComponent = (props) => createElement('div', null,
      createElement('button', { 'data-test': 'call', onClick: () => void props.tools!.dispatch({ name: 'pick_lineage', arguments: { projectId: 'p1', name: 'Phoenix' } }) }, 'Pick'),
      createElement('button', { 'data-test': 'undo', onClick: () => void props.tools!.dispatch({ name: 'undo_edit', arguments: { editId: props.history![0].id } }) }, 'Undo'),
      ...(props.history ?? []).map(e => createElement('span', { key: e.id }, e.summary)))
    await act(async () => root.render(createElement(FoundryPanel, { Thread })))
    await act(async () => host.querySelector<HTMLElement>('[data-foundry=creature]')!.click())
    await act(async () => host.querySelector<HTMLElement>('[data-test=call]')!.click())
    expect(host.textContent).toContain('Lineage: Phoenix')
    expect(host.querySelector<HTMLSelectElement>('select')!.value).toBe('Phoenix')
    await act(async () => host.querySelector<HTMLElement>('[data-test=undo]')!.click())
    expect(host.querySelector<HTMLSelectElement>('select')!.value).toBe('')
    expect(host.textContent).toContain('Undid: Lineage: Phoenix')
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(host.textContent).toContain('Name: Alpha; lineage: Seeded')
  })

  it('runs a bridged edit.call through the same dispatcher the pane shows, then reports it', async () => {
    state.sidebar = ready('First')
    await paint()
    expect([...state.handlers.keys()]).toEqual(['edit.call'])
    await act(async () => { state.handlers.get('edit.call')!({ callId: 'c1', call: { name: 'pick_lineage', arguments: { projectId: 'p1', name: 'Phoenix' } } }) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(state.bridge.map(([m]) => m)).toEqual(['edit.claim', 'edit.report'])
    expect(state.bridge[1][1]).toMatchObject({ callId: 'c1', result: { ok: true, status: 'committed' } })
  })

  it('renders one form history entry and undoes a lineage edit from the thread', async () => {
    state.sidebar = ready('First')
    await paint()
    await act(async () => host.querySelector<HTMLElement>('[data-foundry=creature]')!.click())
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Re-roll')!.click())
    const entry = host.querySelector<HTMLElement>('[data-foundry=line-edit]')!
    expect(entry.textContent).toContain('Lineage:')
    expect(host.querySelectorAll('[data-foundry=line-edit]')).toHaveLength(1)
    expect(host.querySelector<HTMLSelectElement>('select')!.value).not.toBe('')
    await act(async () => entry.querySelector<HTMLButtonElement>('button')!.click())
    expect(host.querySelector<HTMLSelectElement>('select')!.value).toBe('')
    expect(host.textContent).toContain('Undid: Lineage:')
    expect(entry.querySelector('button')).toBeNull()
  })

  it('keeps the same inspector and its draft when a sidebar update replaces the source object', async () => {
    state.sidebar = ready('First')
    await paint()
    await act(async () => host.querySelector<HTMLElement>('[data-foundry=creature]')!.click())
    const input = host.querySelector<HTMLInputElement>('[data-foundry=drawer] input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Draft Moss')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    state.sidebar = ready('Updated thread')
    await paint()
    expect(host.querySelector('[data-foundry=drawer] input')).toBe(input)
    expect(input.value).toBe('Draft Moss')
  })

  it('lays the pane out below the host chrome row, in the flow, not against the window', async () => {
    state.sidebar = ready('First')
    await paint()
    const outer = host.firstElementChild as HTMLElement
    expect(outer.style.paddingTop).toContain('--bb-app-chrome-row-height')
    expect(outer.style.position).not.toBe('absolute')
    const wrapper = outer.firstElementChild as HTMLElement
    expect(wrapper.style.position).toBe('relative')
    expect((wrapper.firstElementChild as HTMLElement).style.position).toBe('absolute')
  })

  it('aliases the pane\'s theme variables to bb\'s on the wrapper and uses bb colors for the stale banner', async () => {
    state.sidebar = ready('First')
    await paint()
    const outer = host.firstElementChild as HTMLElement
    for (const [k, v] of Object.entries(THEME_ALIASES)) expect(outer.style.getPropertyValue(k)).toBe(v)
    expect(THEME_ALIASES['--dt-background']).toBe('var(--background)')
    state.sidebar = { ...ready('First'), status: 'error' }
    await paint()
    expect(host.innerHTML).not.toContain('rgba(0, 0, 0')
  })

  it('does not mount the pane when the thread list fails first, and mounts it live after recovery', async () => {
    state.sidebar = { status: 'error' }
    await paint()
    expect(state.registers).toBe(0)
    expect(host.textContent).toContain("Couldn't load threads")
    state.sidebar = ready('First')
    await paint()
    expect(state.registers).toBe(1)
    expect(host.textContent).toContain('PANE')
    const get = state.lastRest as (path: string) => Promise<{ projects: { cards: { title: string }[] }[] }>
    const snap = await get('/snapshot')
    expect(snap.projects[0].cards[0].title).toBe('First')
  })

  it('keeps the last board and says it may be out of date when the list fails later, then clears on recovery', async () => {
    state.sidebar = ready('First')
    await paint()
    state.sidebar = { status: 'error' }
    await paint()
    expect(host.textContent).toContain('PANE')
    expect(host.textContent).toContain('Thread list unavailable')
    state.sidebar = ready('First')
    await paint()
    expect(host.textContent).not.toContain('Thread list unavailable')
    expect(state.registers).toBe(1)
  })

  it('puts the Foundry pane to the right of the board, in the same row, only once there is data', async () => {
    state.sidebar = { status: 'loading' }
    await paint()
    expect(host.querySelector('[data-foundry=pane]')).toBeNull()
    state.sidebar = ready('First')
    await paint()
    const outer = host.firstElementChild as HTMLElement
    expect(outer.style.flexDirection).toBe('row')
    expect([...outer.children].map((c) => c.getAttribute('data-foundry'))).toEqual([null, 'pane'])
    expect((outer.lastElementChild as HTMLElement).style.width).toBe('22%')
  })

  it('opens the drawer for a creature, and keeps the outline (and drawer) when the list fails later', async () => {
    state.sidebar = ready('First')
    await paint()
    const alpha = [...host.querySelectorAll<HTMLElement>('[data-foundry=creature]')].find((e) => e.textContent === 'Alpha')!
    act(() => { alpha.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(host.querySelector('[data-foundry=drawer]')).not.toBeNull()
    state.sidebar = { status: 'error' }
    await paint()
    expect(host.querySelector('[data-foundry=drawer]')).not.toBeNull()
  })

  it('closes the drawer when the selected creature leaves the thread list', async () => {
    state.sidebar = ready('First')
    await paint()
    const alpha = [...host.querySelectorAll<HTMLElement>('[data-foundry=creature]')].find((e) => e.textContent === 'Alpha')!
    act(() => { alpha.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    state.sidebar = { ...ready('First'), projects: [{ id: 'p2', name: 'Beta' }], threads: [] }
    await paint()
    expect(host.querySelector('[data-foundry=drawer]')).toBeNull()
  })

  it('re-reads the clock on a timer, so an idle card turns done without any sidebar update', async () => {
    vi.useFakeTimers()
    const t0 = new Date('2026-11-06T12:00:00Z').getTime()
    vi.setSystemTime(t0)
    const s = ready('Old') as ReturnType<typeof ready>
    s.threads[0].updatedAt = t0
    state.sidebar = s
    await paint()
    const get = state.lastRest as (path: string) => Promise<{ projects: { cards: { status: string }[] }[] }>
    expect((await get('/snapshot')).projects[0].cards[0].status).toBe('open')
    vi.setSystemTime(t0 + 25 * 3600 * 1000)
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect((await get('/snapshot')).projects[0].cards[0].status).toBe('done')
  })
})
