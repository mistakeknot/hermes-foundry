// A fake of the bb SDK surface the bb sections backend uses, behaving like the real server where it matters:
//  - sections are GLOBAL and name-only; names are unique by EXACT text (case-sensitive), a clash is HTTP 409 `section_name_conflict`;
//  - the section list comes back ordered by name, not by creation;
//  - rename returns `updatedThreadCount` (0 in the live bb); delete clears every assignment and deletes no thread;
//  - `threads.update` with a `sectionId` (or null) moves a thread and bumps its `updatedAt`;
//  - `threads.list` filters by project / section / ids and pages with limit and offset (a call returns at most 200 rows);
//  - unknown ids are HTTP 404.
import type { BbSectionMutation, BbSectionsSdk, BbThreadListArgs, BbThreadRow, BbThreadSection } from '../../src/sections/bb-backend'

/** Shaped like the SDK's BbHttpError: a named Error with `status`, `code` and `body`. */
export class FakeBbHttpError extends Error {
  override name = 'BbHttpError'
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
  get body(): { error: string; code: string } {
    return { error: this.message, code: this.code }
  }
}

export interface FakeBbOptions {
  /** Threads that exist from the start, as [id, projectId, sectionId]. */
  threads?: ReadonlyArray<readonly [id: string, projectId: string, sectionId?: string | null]>
}

export class FakeBb implements BbSectionsSdk {
  private clock = 1_000
  private seq = 0
  private sectionRows = new Map<string, BbThreadSection>()
  private threadRows = new Map<string, BbThreadRow>()
  /** Every SDK call, in order, as "area.method". */
  readonly calls: string[] = []
  /** Set to make the next call to a method (e.g. "threadSections.create") throw this once. */
  failNext = new Map<string, unknown>()

  constructor(opts: FakeBbOptions = {}) {
    for (const [id, projectId, sectionId] of opts.threads ?? []) {
      this.threadRows.set(id, { id, projectId, sectionId: sectionId ?? null, updatedAt: this.tick() })
    }
  }

  private tick(): number { return ++this.clock }

  private enter(method: string): void {
    this.calls.push(method)
    const f = this.failNext.get(method)
    if (f !== undefined) {
      this.failNext.delete(method)
      throw f
    }
  }

  /** Test helpers that act as "someone else in bb", outside the backend. */
  addSection(name: string): BbThreadSection {
    const now = this.tick()
    const row = { id: `sec_${(++this.seq).toString().padStart(6, '0')}`, name, createdAt: now, updatedAt: now }
    this.sectionRows.set(row.id, row)
    return { ...row }
  }
  addThread(id: string, projectId: string, sectionId: string | null = null): void {
    this.threadRows.set(id, { id, projectId, sectionId, updatedAt: this.tick() })
  }
  rawSections(): BbThreadSection[] { return [...this.sectionRows.values()].map((s) => ({ ...s })) }
  rawThread(id: string): BbThreadRow | undefined { const t = this.threadRows.get(id); return t && { ...t } }

  private nameTaken(name: string, exceptId?: string): boolean {
    for (const s of this.sectionRows.values()) if (s.id !== exceptId && s.name === name) return true
    return false
  }

  readonly threadSections: BbSectionsSdk['threadSections'] = {
    list: async () => {
      this.enter('threadSections.list')
      return [...this.sectionRows.values()].map((s) => ({ ...s })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    },
    create: async ({ name }) => {
      this.enter('threadSections.create')
      if (this.nameTaken(name)) throw new FakeBbHttpError(409, 'section_name_conflict', `a section named "${name}" already exists`)
      return this.addSection(name)
    },
    update: async ({ id, name }): Promise<BbSectionMutation> => {
      this.enter('threadSections.update')
      const row = this.sectionRows.get(id)
      if (!row) throw new FakeBbHttpError(404, 'section_not_found', `no such section: ${id}`)
      if (this.nameTaken(name, id)) throw new FakeBbHttpError(409, 'section_name_conflict', `a section named "${name}" already exists`)
      row.name = name
      row.updatedAt = this.tick()
      // The live bb answers 0 on a rename: threads point at the section by id, so no thread row is rewritten.
      return { id, name, updatedThreadCount: 0 }
    },
    delete: async ({ id }): Promise<BbSectionMutation> => {
      this.enter('threadSections.delete')
      const row = this.sectionRows.get(id)
      if (!row) throw new FakeBbHttpError(404, 'section_not_found', `no such section: ${id}`)
      let updatedThreadCount = 0
      for (const t of this.threadRows.values()) {
        if (t.sectionId === id) { t.sectionId = null; updatedThreadCount++ } // assignments only: no thread is deleted
      }
      this.sectionRows.delete(id)
      return { id, name: row.name, updatedThreadCount }
    },
  }

  readonly threads: BbSectionsSdk['threads'] = {
    list: async (args: BbThreadListArgs = {}) => {
      this.enter('threads.list')
      const ids = args.threadIds ? new Set(args.threadIds) : null
      if (ids && ids.size > 200) throw new FakeBbHttpError(400, 'invalid_request', 'threadIds is limited to 200')
      const limit = Math.min(args.limit ?? 200, 200)
      const rows = [...this.threadRows.values()]
        .filter((t) => (args.projectId === undefined || t.projectId === args.projectId) && (args.sectionId === undefined || t.sectionId === args.sectionId) && (!ids || ids.has(t.id)))
        .sort((a, b) => b.updatedAt - a.updatedAt) // bb lists most recently touched first
      return rows.slice(args.offset ?? 0, (args.offset ?? 0) + limit).map((t) => ({ ...t }))
    },
    update: async ({ threadId, sectionId }) => {
      this.enter('threads.update')
      const t = this.threadRows.get(threadId)
      if (!t) throw new FakeBbHttpError(404, 'thread_not_found', `no such thread: ${threadId}`)
      if (sectionId !== undefined && sectionId !== null && !this.sectionRows.has(sectionId)) {
        throw new FakeBbHttpError(404, 'section_not_found', `no such section: ${sectionId}`)
      }
      if (sectionId !== undefined) t.sectionId = sectionId
      t.updatedAt = this.tick()
      return { ...t }
    },
  }
}
