// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useReducer } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FoundryPane } from '../src/pane'
import { initialPaneState, paneReducer } from '../src/pane-state'
import { buildOutline } from '../src/selection'
import type { InspectorComponent, ThreadComponent } from '../src/thread-port'
import type { SidebarStateLike } from '../src/from-sidebar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const th = (id: string, projectId: string, sectionId: string | null) => ({ id, projectId, displayTitle: id, sectionId, providerId: 'x', status: 'idle', hasPendingInteraction: false, isUnread: false, isArchived: false, isHidden: false, updatedAt: 0 })
const sidebar: SidebarStateLike = {
  projects: [{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }],
  sections: [{ id: 's1', name: 'Docs' }],
  threads: [th('a', 'p1', 's1'), th('b', 'p1', null), th('c', 'p2', null)],
}
const outline = buildOutline(sidebar)

function Harness(props: { Thread?: ThreadComponent; Inspector?: InspectorComponent }) {
  const [state, dispatch] = useReducer(paneReducer, initialPaneState)
  return createElement(FoundryPane, { state, dispatch, outline, ...props })
}

describe('FoundryPane', () => {
  let host: HTMLDivElement
  let root: Root
  const paint = (props: Parameters<typeof Harness>[0] = {}) => act(() => { root.render(createElement(Harness, props)) })
  const q = (sel: string) => host.querySelector(sel) as HTMLElement | null
  const click = (el: HTMLElement | null) => act(() => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  const byText = (sel: string, text: string) => [...host.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent === text) ?? null

  beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
  afterEach(() => { act(() => root.unmount()); host.remove() })

  it('is a column at a fifth of the width: the thread fills it and no drawer is open before a selection', () => {
    paint()
    const pane = q('[data-foundry=pane]')!
    expect(pane.style.display).toBe('flex')
    expect(pane.style.flexDirection).toBe('column')
    expect(pane.style.width).toBe('22%')
    expect(q('[data-foundry=thread]')!.style.flex).toBe('1 1 0%')
    expect(q('[data-foundry=drawer]')).toBeNull()
    expect(pane.textContent).toContain('No creature or limb selected.')
  })

  it('follows the bb theme through its variables, with no hard-coded colors', () => {
    paint()
    click(byText('[data-foundry=creature]', 'Alpha'))
    const html = host.innerHTML
    expect(html).toContain('var(--border)')
    expect(html).toContain('var(--card)')
    expect(html).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(|rgba\(/i)
  })

  it('opens the drawer below the thread when a creature is selected, and attaches the selection to the thread', () => {
    paint()
    click(byText('[data-foundry=creature]', 'Alpha'))
    const pane = q('[data-foundry=pane]')!
    const kids = [...pane.children].map((c) => c.getAttribute('data-foundry'))
    expect(kids).toEqual(['picker', 'thread', 'drawer'])
    expect(q('[data-foundry=thread-context]')!.textContent).toBe('Context: Alpha')
    expect(q('[data-foundry=drawer]')!.style.maxHeight).toBe('55%')
  })

  it('offers the selected creature\'s limbs, including Unsorted, and a limb selection replaces the creature one', () => {
    paint()
    expect(q('[data-foundry=limb]')).toBeNull()
    click(byText('[data-foundry=creature]', 'Alpha'))
    expect([...host.querySelectorAll('[data-foundry=limb]')].map((e) => e.textContent)).toEqual(['Docs', 'Unsorted'])
    click(byText('[data-foundry=limb]', 'Unsorted'))
    expect(q('[data-foundry=thread-context]')!.textContent).toBe('Context: Alpha › Unsorted')
    expect(q('[data-foundry=drawer]')!.getAttribute('aria-label')).toBe('Inspector: Alpha › Unsorted')
  })

  it('closes on the close button and on choosing the same item again', () => {
    paint()
    click(byText('[data-foundry=creature]', 'Beta'))
    expect(q('[data-foundry=drawer]')).not.toBeNull()
    click(q('[data-foundry=drawer-close]'))
    expect(q('[data-foundry=drawer]')).toBeNull()
    click(byText('[data-foundry=creature]', 'Beta'))
    click(byText('[data-foundry=creature]', 'Beta'))
    expect(q('[data-foundry=drawer]')).toBeNull()
    expect(q('[data-foundry=thread-context]')).toBeNull()
  })

  it('shows a form edit from the drawer slot as a line in the thread', () => {
    const Inspector: InspectorComponent = ({ context, onEdit }) => createElement('button', { 'data-test': 'edit', onClick: () => onEdit(`name set (${context.threadIds.length} cards)`) }, 'edit')
    paint({ Inspector })
    click(byText('[data-foundry=creature]', 'Alpha'))
    click(q('[data-test=edit]'))
    expect(q('[data-foundry=line-edit]')!.textContent).toBe('Alpha: name set (2 cards)')
  })

  it('hands the thread slot the context and lines through its interface', () => {
    const seen = vi.fn()
    const Thread: ThreadComponent = (p) => { seen(p.context?.label ?? null, p.lines.length); return createElement('div', { 'data-foundry': 'thread' }, 'custom') }
    paint({ Thread })
    click(byText('[data-foundry=creature]', 'Beta'))
    expect(host.textContent).toContain('custom')
    expect(seen).toHaveBeenLastCalledWith('Beta', 0)
  })
})
