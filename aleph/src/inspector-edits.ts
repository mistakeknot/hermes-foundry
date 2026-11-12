import { LINEAGES, pickLineage } from '../../desktop/src/creature'
import type { CreaturePreference, LineageStore } from './lineage/store'
import type { Section, SectionsBackend } from './sections/types'
import type { SidebarStateLike } from './from-sidebar'
import { visibleName } from './sections/bb-backend'

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
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private sections: SectionsBackend, private lineages: LineageStore) {}
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  version = () => this.revision
  has(id: string) { return this.values.has(id) }
  project(id: string): ProjectEdits { return structuredClone(this.values.get(id) ?? { creature: {}, sections: [] }) }
  private async read(id: string) {
    const [creature, sections] = await Promise.all([this.lineages.get(id), this.sections.list(id)])
    this.values.set(id, { creature, sections }); this.revision++
    this.listeners.forEach(fn => fn())
  }
  private serial(fn: () => Promise<void>) {
    const run = this.tail.then(fn, fn); this.tail = run.catch(() => undefined); return run
  }
  refresh(id: string) { return this.serial(() => this.read(id)) }
  saveCreature(id: string, patch: CreaturePreference) {
    return this.serial(async () => { await this.lineages.set(id, patch); await this.read(id) })
  }
  reroll(id: string) {
    return this.serial(async () => {
      const current = await this.lineages.get(id)
      const picked = pickLineage(id, current.lineage)
      const ordered = [...LINEAGES].sort((a, b) => a.id.localeCompare(b.id, 'en'))
      // Select the next catalogue entry from the current pick, including an explicit name.
      const next = ordered[(ordered.findIndex(x => x.id === picked?.id) + 1) % ordered.length]
      await this.lineages.set(id, { lineage: { name: next.name } }); await this.read(id)
    })
  }
  saveSection(id: string, sectionId: string, name: string, members: readonly string[]) {
    return this.serial(async () => {
      try {
        const current = await this.sections.rename(id, sectionId, name)
        const wanted = new Set(members)
        for (const card of current.cardIds) if (!wanted.has(card)) await this.sections.moveCard(id, card, null)
        for (const card of wanted) if (!current.cardIds.includes(card)) await this.sections.moveCard(id, card, sectionId)
      } finally { await this.read(id) }
    })
  }
  moveCard(id: string, cardId: string, sectionId: string | null) {
    return this.serial(async () => { try { await this.sections.moveCard(id, cardId, sectionId) } finally { await this.read(id) } })
  }
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
