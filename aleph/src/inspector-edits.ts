import { LINEAGES, pickLineage } from '../../desktop/src/creature'
import type { CreaturePreference, LineageStore } from './lineage/store'
import { SectionsError, type Section, type SectionsBackend } from './sections/types'
import type { SidebarStateLike } from './from-sidebar'
import { visibleName } from './sections/bb-backend'

export interface EditEntry { id: number; projectId: string; summary: string; undoable: boolean }

export interface ProjectEdits { creature: CreaturePreference; sections: Section[] }
export interface FoundryEdits {
  refresh(projectId: string): Promise<void>
  saveCreature(projectId: string, patch: CreaturePreference): Promise<void>
  reroll(projectId: string): Promise<void>
  saveSection(projectId: string, sectionId: string, name: string, members: readonly string[]): Promise<void>
  moveCard(projectId: string, cardId: string, sectionId: string | null): Promise<void>
}

/** Shared by forms and thread tools. Publish read-back state after every write, including partial backend failures. */
export class InspectorEdits implements FoundryEdits {
  private values = new Map<string, ProjectEdits>()
  private listeners = new Set<() => void>()
  private revision = 0
  private entries: EditEntry[] = []
  private inverses = new Map<number, { projectId: string; matches: () => boolean; restore: () => Promise<void> }>()
  private nextEdit = 1
  history = (): EditEntry[] => structuredClone(this.entries)
  private publish() { this.revision++; this.listeners.forEach(fn => fn()) }
  private record(projectId: string, summary: string, inverse?: { matches: () => boolean; restore: () => Promise<void> }) {
    const id = this.nextEdit++
    this.entries.push({ id, projectId, summary, undoable: !!inverse })
    if (inverse) this.inverses.set(id, { projectId, ...inverse })
    if (this.entries.length > 200) this.inverses.delete(this.entries.shift()!.id)
    this.publish()
  }
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private sections: SectionsBackend, private lineages: LineageStore) {}
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  version = () => this.revision
  has(id: string) { return this.values.has(id) }
  project(id: string): ProjectEdits { return structuredClone(this.values.get(id) ?? { creature: {}, sections: [] }) }
  private async read(id: string) {
    const [creature, sections] = await Promise.all([this.lineages.get(id), this.sections.list(id)])
    this.values.set(id, { creature, sections }); this.publish()
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn); this.tail = run.catch(() => undefined); return run
  }
  /** Capture, validate and write within the same queue as form edits. Do not retain the direct writer. */
  exclusive<T>(work: (writer: FoundryEdits & { renameSection: (id: string, sectionId: string, name: string) => Promise<void>; undo: (editId: number) => Promise<void> }) => Promise<T>) {
    return this.serial(() => work(this.direct))
  }
  private direct = {
    refresh: (id: string) => this.read(id),
    saveCreature: async (id: string, patch: CreaturePreference) => {
      await this.read(id)
      const before = this.project(id).creature
      await this.lineages.set(id, patch); await this.read(id)
      const after = this.project(id).creature
      const lineageOnly = patch.name === undefined && patch.lineage !== undefined
      this.record(id, patch.name !== undefined ? `Name: ${after.name}; lineage: ${after.lineage?.name ?? 'Seeded'}` : `Lineage: ${after.lineage?.name ?? 'Seeded'}`, lineageOnly ? {
        matches: () => JSON.stringify(this.project(id).creature.lineage) === JSON.stringify(after.lineage),
        restore: async () => { await this.lineages.set(id, { lineage: before.lineage ?? {} }); await this.read(id) },
      } : undefined)
    },
    reroll: async (id: string) => {
      const current = await this.lineages.get(id)
      const picked = pickLineage(id, current.lineage)
      const ordered = [...LINEAGES].sort((a, b) => a.id.localeCompare(b.id, 'en'))
      const next = ordered[(ordered.findIndex(x => x.id === picked?.id) + 1) % ordered.length]
      await this.direct.saveCreature(id, { lineage: { name: next.name } })
    },
    renameSection: async (id: string, sectionId: string, name: string) => {
      await this.read(id)
      const before = this.project(id).sections.find(s => s.id === sectionId)
      if (!before) throw new SectionsError('not_found', 'No such section')
      try { await this.sections.rename(id, sectionId, name) } finally { await this.read(id) }
      const after = this.project(id).sections.find(s => s.id === sectionId)!
      this.record(id, `Section: ${after.name}`, {
        matches: () => this.project(id).sections.find(s => s.id === sectionId)?.name === after.name,
        restore: async () => { try { await this.sections.rename(id, sectionId, before.name) } finally { await this.read(id) } },
      })
    },
    saveSection: async (id: string, sectionId: string, name: string, members: readonly string[]) => {
      try {
        const current = await this.sections.rename(id, sectionId, name)
        const wanted = new Set(members)
        for (const card of current.cardIds) if (!wanted.has(card)) await this.sections.moveCard(id, card, null)
        for (const card of wanted) if (!current.cardIds.includes(card)) await this.sections.moveCard(id, card, sectionId)
      } finally { await this.read(id) }
      this.record(id, `Section: ${this.project(id).sections.find(s => s.id === sectionId)!.name} (${members.length} members)`)
    },
    moveCard: async (id: string, cardId: string, sectionId: string | null) => {
      await this.read(id)
      const source = this.project(id).sections.find(s => s.cardIds.includes(cardId))?.id ?? null
      try { await this.sections.moveCard(id, cardId, sectionId) } finally { await this.read(id) }
      const target = this.project(id).sections.find(s => s.id === sectionId)
      this.record(id, `Moved thread ${cardId} to ${target?.name ?? 'Unsorted'}`, {
        matches: () => (this.project(id).sections.find(s => s.cardIds.includes(cardId))?.id ?? null) === sectionId,
        restore: async () => { try { await this.sections.moveCard(id, cardId, source) } finally { await this.read(id) } },
      })
    },
    undo: async (editId: number) => {
      const inverse = this.inverses.get(editId)
      if (!inverse) throw new SectionsError('not_found', 'No undoable edit')
      await this.read(inverse.projectId)
      if (!inverse.matches()) throw Object.assign(new Error('This item changed after the edit'), { code: 'conflict' })
      await inverse.restore()
      this.inverses.delete(editId)
      const entry = this.entries.find(e => e.id === editId)!
      entry.undoable = false
      this.record(inverse.projectId, `Undid: ${entry.summary}`)
    },
  }
  refresh(id: string) { return this.serial(() => this.direct.refresh(id)) }
  saveCreature(id: string, patch: CreaturePreference) { return this.serial(() => this.direct.saveCreature(id, patch)) }
  reroll(id: string) { return this.serial(() => this.direct.reroll(id)) }
  saveSection(id: string, sectionId: string, name: string, members: readonly string[]) { return this.serial(() => this.direct.saveSection(id, sectionId, name, members)) }
  moveCard(id: string, cardId: string, sectionId: string | null) { return this.serial(() => this.direct.moveCard(id, cardId, sectionId)) }
  /** bb sidebar projection: use committed backend membership, never a second optimistic store. */
  sidebar(input: SidebarStateLike): SidebarStateLike {
    const sections = input.sections.map(s => ({ ...s, name: input.projects.reduce((name, p) => visibleName(p.id, s.name) ?? name, s.name) }))
    for (const [id, state] of this.values) {
      for (const s of state.sections) {
        const row = { id: s.id, name: s.name }
        const index = sections.findIndex(x => x.id === s.id)
        if (index < 0) sections.push(row); else sections[index] = row
      }
    }
    return {
      projects: input.projects.map(p => ({ ...p, name: this.values.get(p.id)?.creature.name ?? p.name })), sections,
      threads: input.threads.map(t => {
        const state = this.values.get(t.projectId)
        if (!state) return t
        return { ...t, sectionId: state.sections.find(s => s.cardIds.includes(t.id))?.id ?? null }
      }),
    }
  }
}
