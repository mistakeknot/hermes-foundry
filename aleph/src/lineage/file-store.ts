import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { checkProject, preference, type CreaturePreference, type LineageStore } from './store'

/** One plugin-owned file. One instance owns its serialized read/merge/atomic-replace queue. */
export class FileLineageStore implements LineageStore {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private path: string) {}
  private async read(): Promise<Record<string, CreaturePreference>> {
    let text: string
    try { text = await readFile(this.path, 'utf8') } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return Object.create(null)
      throw e
    }
    const doc = JSON.parse(text)
    if (doc?.v !== 1 || !doc.projects || typeof doc.projects !== 'object' || Array.isArray(doc.projects)) throw new Error('Invalid lineage file')
    const projects: Record<string, CreaturePreference> = Object.create(null)
    for (const [id, value] of Object.entries(doc.projects)) { checkProject(id); projects[id] = preference(value) }
    return projects
  }
  async get(id: string) { checkProject(id); await this.tail; return (await this.read())[id] ?? {} }
  set(id: string, patch: CreaturePreference): Promise<CreaturePreference> {
    const run = this.tail.then(async () => {
      checkProject(id)
      const checked = preference(patch)
      const projects = await this.read()
      projects[id] = { ...projects[id], ...checked }
      await mkdir(dirname(this.path), { recursive: true })
      const temp = `${this.path}.${randomUUID()}.tmp`
      await writeFile(temp, JSON.stringify({ v: 1, projects }) + '\n', { mode: 0o600, flag: 'wx' })
      await rename(temp, this.path)
      return structuredClone(projects[id])
    })
    this.tail = run.catch(() => undefined)
    return run
  }
}
