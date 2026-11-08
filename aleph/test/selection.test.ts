import { describe, expect, it } from 'vitest'
import type { SidebarStateLike, SidebarThreadLike } from '../src/from-sidebar'
import { buildOutline, contextFor, sameSelection, toggleSelection, UNSORTED, type Selection } from '../src/selection'
import { initialPaneState, MAX_LINES, paneReducer } from '../src/pane-state'
import { DRAWER_MAX_PCT, PANE_WIDTH_PCT, paneLayout } from '../src/layout'

const t = (id: string, projectId: string, sectionId: string | null, extra: Partial<SidebarThreadLike> = {}): SidebarThreadLike => ({
  id, projectId, displayTitle: id, sectionId, providerId: 'x', status: 'idle', hasPendingInteraction: false, isUnread: false, isArchived: false, isHidden: false, updatedAt: 0, ...extra,
})
const state: SidebarStateLike = {
  projects: [{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }],
  sections: [{ id: 's1', name: 'Docs' }, { id: 's2', name: 'Build' }],
  threads: [
    t('a', 'p1', 's2'), t('b', 'p1', 's1'), t('c', 'p1', null), t('d', 'p1', 'gone'),
    t('e', 'p1', 's1', { isArchived: true }), t('f', 'p1', 's2', { isHidden: true }),
    t('g', 'p2', null),
  ],
}
const outline = buildOutline(state)
const creature = (projectId: string): Selection => ({ kind: 'creature', projectId })
const limb = (projectId: string, sectionId: string | null): Selection => ({ kind: 'limb', projectId, sectionId })

describe('outline', () => {
  it('makes a creature per project and a limb per section that has a drawn thread, in sidebar order, Unsorted last', () => {
    const alpha = outline[0]
    expect(alpha.limbs.map((l) => [l.sectionId, l.name, l.threadIds])).toEqual([
      ['s1', 'Docs', ['b']],
      ['s2', 'Build', ['a']],
      [null, UNSORTED, ['c', 'd']],
    ])
    expect(alpha.threadIds).toEqual(['a', 'b', 'c', 'd'])
  })
  it('puts a thread in a section the sidebar does not know under Unsorted, and leaves out archived and hidden threads', () => {
    expect(outline[0].limbs.at(-1)!.threadIds).toContain('d')
    expect(outline[0].threadIds).not.toContain('e')
    expect(outline[0].threadIds).not.toContain('f')
  })
  it('gives a project with no sections only Unsorted, and one with no threads no limbs', () => {
    expect(outline[1].limbs.map((l) => l.name)).toEqual([UNSORTED])
    expect(buildOutline({ ...state, threads: [] })[0].limbs).toEqual([])
  })
})

describe('selection', () => {
  it('compares by kind, project and section', () => {
    expect(sameSelection(null, null)).toBe(true)
    expect(sameSelection(creature('p1'), null)).toBe(false)
    expect(sameSelection(creature('p1'), creature('p1'))).toBe(true)
    expect(sameSelection(creature('p1'), limb('p1', null))).toBe(false)
    expect(sameSelection(limb('p1', 's1'), limb('p1', 's1'))).toBe(true)
    expect(sameSelection(limb('p1', 's1'), limb('p1', null))).toBe(false)
    expect(sameSelection(limb('p1', null), limb('p2', null))).toBe(false)
  })
  it('selecting the same thing again closes it; anything else replaces it', () => {
    expect(toggleSelection(null, creature('p1'))).toEqual(creature('p1'))
    expect(toggleSelection(creature('p1'), creature('p1'))).toBeNull()
    expect(toggleSelection(creature('p1'), limb('p1', 's1'))).toEqual(limb('p1', 's1'))
  })
  it('turns a selection into the context attached to the thread', () => {
    expect(contextFor(null, outline)).toBeNull()
    expect(contextFor(creature('p1'), outline)).toMatchObject({ kind: 'creature', label: 'Alpha', threadIds: ['a', 'b', 'c', 'd'], sectionId: null })
    expect(contextFor(limb('p1', 's1'), outline)).toMatchObject({ kind: 'limb', label: 'Alpha › Docs', sectionName: 'Docs', threadIds: ['b'] })
    expect(contextFor(limb('p1', null), outline)).toMatchObject({ label: `Alpha › ${UNSORTED}`, sectionId: null })
  })
  it('has no context for a project or limb that no longer exists', () => {
    expect(contextFor(creature('nope'), outline)).toBeNull()
    expect(contextFor(limb('p2', 's1'), outline)).toBeNull()
  })
})

describe('pane state', () => {
  it('opens on select, closes on the same select or on close', () => {
    let s = paneReducer(initialPaneState, { type: 'toggle', target: creature('p1') })
    expect(s.selection).toEqual(creature('p1'))
    s = paneReducer(s, { type: 'toggle', target: limb('p1', 's1') })
    expect(s.selection).toEqual(limb('p1', 's1'))
    s = paneReducer(s, { type: 'toggle', target: limb('p1', 's1') })
    expect(s.selection).toBeNull()
    s = paneReducer(paneReducer(s, { type: 'toggle', target: creature('p2') }), { type: 'close' })
    expect(s.selection).toBeNull()
    expect(paneReducer(s, { type: 'close' })).toBe(s)
  })
  it('records a form edit as a line with what was selected, and ignores blank text', () => {
    let s = paneReducer(initialPaneState, { type: 'line', kind: 'edit', text: '  renamed to Gamma ', about: 'Alpha' })
    expect(s.lines).toEqual([{ id: 1, kind: 'edit', text: 'renamed to Gamma', about: 'Alpha' }])
    expect(paneReducer(s, { type: 'line', kind: 'edit', text: '   ', about: null })).toBe(s)
    s = paneReducer(s, { type: 'line', kind: 'note', text: 'hi', about: null })
    expect(s.lines.map((l) => l.id)).toEqual([1, 2])
  })
  it('keeps at most MAX_LINES lines, newest last', () => {
    let s = initialPaneState
    for (let i = 0; i < MAX_LINES + 5; i++) s = paneReducer(s, { type: 'line', kind: 'note', text: `n${i}`, about: null })
    expect(s.lines).toHaveLength(MAX_LINES)
    expect(s.lines.at(-1)!.text).toBe(`n${MAX_LINES + 4}`)
  })
  it('closes the drawer when the selection disappears from the outline, and keeps it otherwise', () => {
    const open = paneReducer(initialPaneState, { type: 'toggle', target: limb('p1', 's1') })
    expect(paneReducer(open, { type: 'reconcile', outline })).toBe(open)
    const emptied = buildOutline({ ...state, threads: state.threads.filter((x) => x.id !== 'b') })
    expect(paneReducer(open, { type: 'reconcile', outline: emptied }).selection).toBeNull()
  })
})

describe('layout', () => {
  it('is a fifth to a quarter of the width, with the drawer open only while something is selected', () => {
    expect(PANE_WIDTH_PCT).toBeGreaterThanOrEqual(20)
    expect(PANE_WIDTH_PCT).toBeLessThanOrEqual(25)
    expect(paneLayout(null)).toMatchObject({ width: `${PANE_WIDTH_PCT}%`, drawerOpen: false, threadFlex: '1 1 0%' })
    expect(paneLayout(creature('p1')).drawerOpen).toBe(true)
    expect(paneLayout(limb('p1', null)).drawerMaxHeight).toBe(`${DRAWER_MAX_PCT}%`)
  })
})
