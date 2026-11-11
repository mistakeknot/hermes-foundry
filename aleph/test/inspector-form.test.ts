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
