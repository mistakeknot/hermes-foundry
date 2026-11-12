// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { InspectorForm } from '../src/inspector-form'
import { InspectorEdits } from '../src/inspector-edits'
import { MemorySectionsBackend } from '../src/sections/memory-backend'
import { MemoryLineageStore } from '../src/lineage/store'
import type { SelectionContext } from '../src/selection'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const typeName = (host: HTMLElement, value: string) => act(async () => {
  const input = host.querySelector('input')!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})

it('keeps dirty creature fields across other-project and same-project refreshes, adopts untouched fields, and resets after Save', async () => {
  const store = new MemoryLineageStore(), edits = new InspectorEdits(new MemorySectionsBackend(), store)
  await edits.refresh('p')
  const host = document.createElement('div'), root = createRoot(host)
  const context: SelectionContext = { kind: 'creature', projectId: 'p', projectName: 'Alpha', sectionId: null, sectionName: null, threadIds: [], label: 'Alpha' }
  try {
    await act(async () => root.render(createElement(InspectorForm, { context, onEdit: () => {}, edits, threads: [] })))
    await typeName(host, 'Draft Moss')
    await act(async () => edits.refresh('q'))
    expect(host.querySelector('input')!.value).toBe('Draft Moss')
    await act(async () => [...host.querySelectorAll('button')].find(x => x.textContent === 'Re-roll')!.click())
    expect(host.querySelector('input')!.value).toBe('Draft Moss')
    await store.set('p', { name: 'External', lineage: { name: 'Phoenix' } })
    await act(async () => edits.refresh('p'))
    expect(host.querySelector('input')!.value).toBe('Draft Moss')
    expect(host.querySelector('select')!.value).toBe('Phoenix')
    await act(async () => {
      const select = host.querySelector('select')!
      select.value = 'Griffin'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await store.set('p', { lineage: {} })
    await act(async () => edits.refresh('p'))
    expect(host.querySelector('select')!.value).toBe('Griffin')
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await store.set('p', { name: 'After Save', lineage: { name: 'Phoenix' } })
    await act(async () => edits.refresh('p'))
    expect(host.querySelector('input')!.value).toBe('After Save')
    expect(host.querySelector('select')!.value).toBe('Phoenix')
    await typeName(host, 'Discard on selection change')
    await act(async () => root.render(createElement(InspectorForm, { context: { ...context, projectId: 'q', projectName: 'Beta' }, onEdit: () => {}, edits, threads: [] })))
    expect(host.querySelector('input')!.value).toBe('Beta')
  } finally { act(() => root.unmount()) }
})

it('preserves section drafts and validation errors through refresh and adopts untouched membership', async () => {
  const sections = new MemorySectionsBackend(), edits = new InspectorEdits(sections, new MemoryLineageStore())
  const limb = await sections.create('p', 'Docs'); await sections.create('p', 'Plans')
  await edits.refresh('p')
  const host = document.createElement('div'), root = createRoot(host)
  const context: SelectionContext = { kind: 'limb', projectId: 'p', projectName: 'Alpha', sectionId: limb.id, sectionName: 'Docs', threadIds: [], label: 'Alpha › Docs' }
  try {
    await act(async () => root.render(createElement(InspectorForm, { context, onEdit: () => {}, edits, threads: [{ id: 'a', projectId: 'p', displayTitle: 'Task' }] })))
    await typeName(host, 'Plans')
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(host.textContent).toContain('Name already exists')
    await act(async () => edits.refresh('q'))
    expect(host.textContent).toContain('Name already exists')
    expect(host.querySelector('input')!.value).toBe('Plans')
    await sections.moveCard('p', 'a', limb.id)
    await act(async () => edits.refresh('p'))
    expect(host.querySelector<HTMLInputElement>('[type=checkbox]')!.checked).toBe(true)
    await act(async () => host.querySelector<HTMLInputElement>('[type=checkbox]')!.click())
    await act(async () => edits.refresh('q'))
    expect(host.querySelector<HTMLInputElement>('[type=checkbox]')!.checked).toBe(false)
    await typeName(host, 'Draft Plans')
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(edits.project('p').sections[0]).toMatchObject({ name: 'Draft Plans', cardIds: [] })
    await sections.moveCard('p', 'a', limb.id)
    await act(async () => edits.refresh('p'))
    expect(host.querySelector<HTMLInputElement>('[type=checkbox]')!.checked).toBe(true)
  } finally { act(() => root.unmount()) }
})

it('saves a creature and records only successful edits; reroll and seeded reset are usable', async () => {
  const edits = new InspectorEdits(new MemorySectionsBackend(), new MemoryLineageStore())
  await edits.refresh('p')
  const host = document.createElement('div'), root = createRoot(host), lines: string[] = []
  const context: SelectionContext = { kind: 'creature', projectId: 'p', projectName: 'Alpha', sectionId: null, sectionName: null, threadIds: [], label: 'Alpha' }
  try {
    await act(async () => root.render(createElement(InspectorForm, { context, onEdit: s => lines.push(s), edits, threads: [] })))
    await act(async () => (host.querySelector('form')!).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(edits.project('p').creature.name).toBe('Alpha')
    await act(async () => [...host.querySelectorAll('button')].find(x => x.textContent === 'Re-roll')!.click())
    expect(lines).toHaveLength(2)
    await act(async () => [...host.querySelectorAll('button')].find(x => x.textContent === 'Seeded')!.click())
    expect(edits.project('p').creature.lineage).toEqual({})
  } finally { act(() => root.unmount()) }
})

it('shows duplicate name without recording success, and Unsorted has no rename control', async () => {
  const sections = new MemorySectionsBackend(), edits = new InspectorEdits(sections, new MemoryLineageStore())
  const a = await sections.create('p', 'Docs')
  await sections.create('p', 'Plans'); await edits.refresh('p')
  const host = document.createElement('div'), root = createRoot(host), lines: string[] = []
  const context: SelectionContext = { kind: 'limb', projectId: 'p', projectName: 'Alpha', sectionId: a.id, sectionName: 'Plans', threadIds: [], label: 'Alpha › Plans' }
  try {
    await act(async () => root.render(createElement(InspectorForm, { context, onEdit: s => lines.push(s), edits, threads: [] })))
    // Use native input setter so React observes a real edit.
    await act(async () => {
      const input = host.querySelector('input')!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Plans')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(host.textContent).toContain('Name already exists')
    expect(lines).toEqual([])
    await act(async () => root.render(createElement(InspectorForm, { context: { ...context, sectionId: null, sectionName: 'Unsorted' }, onEdit: s => lines.push(s), edits, threads: [] })))
    expect(host.querySelector('input')).toBeNull()
  } finally { act(() => root.unmount()) }
})
