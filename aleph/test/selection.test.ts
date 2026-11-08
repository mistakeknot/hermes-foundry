import { describe, expect, it } from 'vitest'
import { buildLiveShape } from '../../desktop/src/live'
import { fromSidebar, type SidebarStateLike, type SidebarThreadLike } from '../src/from-sidebar'
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
  it('gives a project with no sections only Unsorted, and a project with no drawn thread no creature (it has no board)', () => {
    expect(outline[1].limbs.map((l) => l.name)).toEqual([UNSORTED])
    expect(buildOutline({ ...state, threads: [] })).toEqual([])
    expect(buildOutline({ ...state, threads: [t('g', 'p2', null)] }).map((c) => c.projectId)).toEqual(['p2'])
  })
  it('leaves out a thread whose project the sidebar does not list', () => {
    expect(buildOutline({ ...state, threads: [t('x', 'nope', null), t('g', 'p2', null)] }).map((c) => c.projectId)).toEqual(['p2'])
  })
})

// The picker must offer exactly what the board draws. The board caps at 240 cards (working and waiting first, then newest),
// so with more threads than that the outline has to cap the same way, never show an 'Omitted' limb or an undrawn card.
const CAP = 240
const boardCards = (s: SidebarStateLike, opts = {}) => buildLiveShape(fromSidebar(s, 0), opts).projects.flatMap((p) => p.cards.map((c) => ({ projectId: p.id, threadId: c.id.slice(p.id.length + 1), epic: c.epic_id })))
const outlineCards = (o: ReturnType<typeof buildOutline>) => o.flatMap((c) => c.limbs.flatMap((l) => l.threadIds.map((threadId) => ({ projectId: c.projectId, threadId, epic: l.sectionId }))))
const keyed = (xs: { projectId: string; threadId: string; epic: string | null }[]) => xs.map((x) => `${x.projectId}/${x.threadId}/${x.epic}`).sort()
const many = (n: number): SidebarThreadLike[] => Array.from({ length: n }, (_, i) => t(`t${String(i).padStart(4, '0')}`, i % 2 ? 'p1' : 'p2', i % 3 === 0 ? 's1' : i % 3 === 1 ? 's2' : null, { updatedAt: i }))

describe('outline matches the board past the 240-card cap', () => {
  it('draws no more than 240 threads and keeps the newest', () => {
    const o = buildOutline({ ...state, threads: many(300) })
    const ids = o.flatMap((c) => c.threadIds)
    expect(ids).toHaveLength(CAP)
    expect(ids).toContain('t0299')
    expect(ids).not.toContain('t0059')
    expect(ids).toContain('t0060')
    expect(o.flatMap((c) => c.limbs.flatMap((l) => l.threadIds))).toHaveLength(CAP)
  })
  it('takes working and waiting threads before newer idle ones, as the board does', () => {
    const old = [t('wait', 'p1', null, { updatedAt: -5, hasPendingInteraction: true }), t('run', 'p1', 's1', { updatedAt: -4, status: 'active' }), t('err', 'p1', null, { updatedAt: -3, status: 'error' })]
    const o = buildOutline({ ...state, threads: [...many(300), ...old] })
    const ids = o.flatMap((c) => c.threadIds)
    expect(ids).toHaveLength(CAP)
    expect(ids).toEqual(expect.arrayContaining(['wait', 'run', 'err']))
    expect(ids).not.toContain('t0061') // pushed out by the three old but active threads
  })
  it('has the same cards, creatures and sections as the board, so it cannot drift from it', () => {
    for (const n of [0, 1, 239, 240, 241, 500]) {
      const s = { ...state, threads: [...many(n), t('arch', 'p1', 's1', { isArchived: true, updatedAt: 1e9 }), t('hid', 'p2', null, { isHidden: true, updatedAt: 1e9 })] }
      const o = buildOutline(s)
      expect(keyed(outlineCards(o)), `n=${n}`).toEqual(keyed(boardCards(s)))
      expect(o.map((c) => c.projectId), `n=${n}`).toEqual(buildLiveShape(fromSidebar(s, 0)).projects.map((p) => p.id).sort((a, b) => (s.projects.findIndex((x) => x.id === a) - s.projects.findIndex((x) => x.id === b))))
    }
  })
  it('follows the board when its cap is changed, and drops a limb that capping empties', () => {
    const s = { ...state, threads: [t('a', 'p1', 's1', { updatedAt: 1 }), t('b', 'p1', 's2', { updatedAt: 9 })] }
    const o = buildOutline(s, { maxCards: 1 })
    expect(o[0].limbs.map((l) => l.sectionId)).toEqual(['s2'])
    expect(keyed(outlineCards(o))).toEqual(keyed(boardCards(s, { maxCards: 1 })))
  })
  it('lets a selection of a capped-out thread fall away: its limb or creature is gone from the outline', () => {
    const s = { ...state, threads: [...many(250), t('only', 'p3', 's2', { updatedAt: -1 })], projects: [...state.projects, { id: 'p3', name: 'Gamma' }] }
    const o = buildOutline(s)
    expect(o.find((c) => c.projectId === 'p3')).toBeUndefined()
    expect(contextFor({ kind: 'limb', projectId: 'p3', sectionId: 's2' }, o)).toBeNull()
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
