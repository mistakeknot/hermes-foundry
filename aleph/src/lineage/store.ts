import { LINEAGES, type LineageSelection } from '../../../desktop/src/creature'

export interface CreaturePreference { name?: string; lineage?: LineageSelection }
export interface LineageStore {
  get(projectId: string): Promise<CreaturePreference>
  /** Merge supplied fields; an empty lineage restores the seeded pick. */
  set(projectId: string, patch: CreaturePreference): Promise<CreaturePreference>
}

export function checkProject(id: string): void {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id)) throw new Error('Invalid project')
}
export function preference(raw: unknown): CreaturePreference {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid creature')
  const p = raw as CreaturePreference
  if (Object.keys(p).some(k => k !== 'name' && k !== 'lineage')) throw new Error('Invalid creature field')
  const out: CreaturePreference = {}
  if (p.name !== undefined) {
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(p.name)) throw new Error('Invalid name')
    out.name = p.name.trim()
  }
  if (p.lineage !== undefined) {
    const l = p.lineage
    if (!l || typeof l !== 'object' || Array.isArray(l) || Object.keys(l).some(k => k !== 'name' && k !== 'reroll')) throw new Error('Invalid lineage')
    out.lineage = {}
    if (l.name !== undefined) {
      if (typeof l.name !== 'string') throw new Error('Invalid lineage')
      const entry = LINEAGES.find(x => x.id === l.name || x.name.toLowerCase() === l.name!.trim().toLowerCase())
      if (!entry) throw new Error('Unknown lineage')
      out.lineage.name = entry.name
    }
    if (l.reroll !== undefined) {
      if (!Number.isSafeInteger(l.reroll) || l.reroll < 0) throw new Error('Invalid reroll')
      out.lineage.reroll = l.reroll
    }
  }
  return out
}

export class MemoryLineageStore implements LineageStore {
  private values = new Map<string, CreaturePreference>()
  async get(id: string) { checkProject(id); return structuredClone(this.values.get(id) ?? {}) }
  async set(id: string, patch: CreaturePreference) {
    checkProject(id)
    const value = { ...this.values.get(id), ...preference(patch) }
    this.values.set(id, value)
    return structuredClone(value)
  }
}
