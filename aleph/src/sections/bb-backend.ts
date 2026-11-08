import { checkCardId, normalizeName } from './model'
import { SectionsError, type Section, type SectionsBackend } from './types'

// The bb backend: Foundry sections over bb's own thread sections.
//
// bb sections are GLOBAL and name-only (one flat list for the whole bb, ids like sec_...), unique by exact name, and a thread
// is in at most one of them (`sectionId` on the thread). A creature (project) therefore gets its sections by a naming
// convention: a Foundry section "Docs" of creature "proj_a" is stored in bb as the section named "foundry/proj_a/Docs".
// Callers only ever see "Docs"; a bb section without that exact prefix is not a section of this creature. The convention and
// its limits are written up in docs/sections-bb.md.

/** The reserved start of every bb section name this backend owns. */
export const SCOPE_PREFIX = 'foundry/'

/** A creature id is a bb project id (or a test slug): letters, digits, `_`, `.`, `-`; never `/`, so the prefix is unambiguous. */
export const CREATURE_ID = /^[A-Za-z0-9_.-]{1,64}$/

/** The bb section name stored for a creature's section. `visibleName` must already be normalised. */
export const scopedName = (creatureId: string, visibleName: string): string => `${SCOPE_PREFIX}${creatureId}/${visibleName}`

/**
 * The creature-visible name of a bb section name, or null when the bb section is not one of this creature's: no prefix, another
 * creature's prefix, or a remainder that is not a valid section name as stored (empty, "Unsorted", too long, untrimmed...).
 */
export function visibleName(creatureId: string, bbName: string): string | null {
  const prefix = `${SCOPE_PREFIX}${creatureId}/`
  if (!bbName.startsWith(prefix)) return null
  const rest = bbName.slice(prefix.length)
  try {
    return normalizeName(rest) === rest ? rest : null
  } catch {
    return null
  }
}

// -- the part of bb's SDK this backend uses (structural: the real `useSdk()` client satisfies it, and so does a fake) ---------

export interface BbThreadSection { id: string; name: string; createdAt: number; updatedAt: number }
export interface BbSectionMutation { id: string; name: string; updatedThreadCount: number }
export interface BbThreadRow { id: string; projectId: string; sectionId: string | null; updatedAt: number }
export interface BbThreadListArgs {
  projectId?: string
  sectionId?: string
  threadIds?: readonly string[]
  includeHidden?: boolean
  limit?: number
  offset?: number
}

export interface BbSectionsSdk {
  threadSections: {
    list(): Promise<readonly BbThreadSection[]>
    create(args: { name: string }): Promise<BbThreadSection>
    update(args: { id: string; name: string }): Promise<BbSectionMutation>
    delete(args: { id: string }): Promise<BbSectionMutation>
  }
  threads: {
    list(args?: BbThreadListArgs): Promise<readonly BbThreadRow[]>
    /** Moving a thread between sections is an update with a section id, or `null` to clear it. */
    update(args: { threadId: string; sectionId?: string | null }): Promise<unknown>
  }
}

/** How many threads one `threads.list` call asks for (bb caps a call; the backend pages until a short page). */
export const THREAD_PAGE = 200

// -- bb's HTTP errors ---------------------------------------------------------------------------------------------------

/** The SDK throws a `BbHttpError` with `status` and the server's `code` (e.g. 409 `section_name_conflict`). Read structurally. */
function httpInfo(e: unknown): { status?: number; code?: string } {
  if (typeof e !== 'object' || e === null) return {}
  const { status, code } = e as { status?: unknown; code?: unknown }
  return { status: typeof status === 'number' ? status : undefined, code: typeof code === 'string' ? code : undefined }
}
const isDuplicate = (e: unknown): boolean => {
  const { status, code } = httpInfo(e)
  return status === 409 || code === 'section_name_conflict'
}
const isNotFound = (e: unknown): boolean => httpInfo(e).status === 404

const duplicate = (name: string): SectionsError => new SectionsError('duplicate_name', `a section named "${name}" already exists`)

const nameKey = (name: string): string => name.toLowerCase()

// -- the backend --------------------------------------------------------------------------------------------------------

interface Mine { id: string; name: string; createdAt: number; bbName: string }

export class BbSectionsBackend implements SectionsBackend {
  /** Writes run one at a time, so a read-check-write (the duplicate check) cannot interleave with another of this backend's writes. */
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly sdk: BbSectionsSdk, private readonly pageSize: number = THREAD_PAGE) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn)
    this.tail = run.catch(() => undefined)
    return run
  }

  private creature(raw: unknown): string {
    if (typeof raw !== 'string' || !CREATURE_ID.test(raw)) throw new SectionsError('invalid_id', 'creature id must be 1..64 characters of letters, digits, "_", "." or "-"')
    return raw
  }

  /** This creature's bb sections, oldest first (bb lists by name; creation time is the order Foundry shows). */
  private async mine(creatureId: string): Promise<Mine[]> {
    const all = await this.sdk.threadSections.list()
    const out: Mine[] = []
    for (const s of all) {
      const name = visibleName(creatureId, s.name)
      if (name !== null) out.push({ id: s.id, name, createdAt: s.createdAt, bbName: s.name })
    }
    return out.sort((a, b) => a.createdAt - b.createdAt) // Array.sort is stable: equal times keep bb's order
  }

  /** The ids of this creature's threads in a bb section, in the order they were last touched (a move touches the thread). */
  private async cardsIn(creatureId: string, sectionId: string): Promise<string[]> {
    const rows: BbThreadRow[] = []
    for (let offset = 0; ; offset += this.pageSize) {
      const page = await this.sdk.threads.list({ projectId: creatureId, sectionId, limit: this.pageSize, offset })
      rows.push(...page)
      if (page.length < this.pageSize) break
    }
    return rows
      .filter((t) => t.projectId === creatureId && t.sectionId === sectionId)
      .sort((a, b) => a.updatedAt - b.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((t) => t.id)
  }

  private static find(sections: readonly Mine[], sectionId: string): Mine {
    const s = sections.find((x) => x.id === sectionId)
    if (!s) throw new SectionsError('not_found', `no such section: ${sectionId}`)
    return s
  }

  async list(creatureId: string): Promise<Section[]> {
    const creature = this.creature(creatureId)
    const sections = await this.mine(creature)
    return Promise.all(sections.map(async (s) => ({ id: s.id, name: s.name, cardIds: await this.cardsIn(creature, s.id) })))
  }

  async create(creatureId: string, rawName: string): Promise<Section> {
    const creature = this.creature(creatureId)
    const name = normalizeName(rawName)
    return this.serial(async () => {
      if ((await this.mine(creature)).some((s) => nameKey(s.name) === nameKey(name))) throw duplicate(name)
      try {
        const made = await this.sdk.threadSections.create({ name: scopedName(creature, name) })
        return { id: made.id, name, cardIds: [] }
      } catch (e) {
        if (isDuplicate(e)) throw duplicate(name) // someone outside Foundry made the same bb name between our check and the call
        throw e
      }
    })
  }

  async rename(creatureId: string, sectionId: string, rawName: string): Promise<Section> {
    const creature = this.creature(creatureId)
    return this.serial(async () => {
      const sections = await this.mine(creature)
      const current = BbSectionsBackend.find(sections, sectionId)
      const name = normalizeName(rawName)
      if (sections.some((s) => s.id !== sectionId && nameKey(s.name) === nameKey(name))) throw duplicate(name)
      try {
        if (name !== current.name) await this.sdk.threadSections.update({ id: current.id, name: scopedName(creature, name) })
      } catch (e) {
        if (isDuplicate(e)) throw duplicate(name)
        if (isNotFound(e)) throw new SectionsError('not_found', `no such section: ${sectionId}`)
        throw e
      }
      return { id: current.id, name, cardIds: await this.cardsIn(creature, current.id) }
    })
  }

  async remove(creatureId: string, sectionId: string): Promise<void> {
    const creature = this.creature(creatureId)
    return this.serial(async () => {
      const current = BbSectionsBackend.find(await this.mine(creature), sectionId)
      try {
        await this.sdk.threadSections.delete({ id: current.id }) // bb clears the assignments; it deletes no thread
      } catch (e) {
        if (isNotFound(e)) throw new SectionsError('not_found', `no such section: ${sectionId}`)
        throw e
      }
    })
  }

  async moveCard(creatureId: string, rawCardId: string, sectionId: string | null): Promise<void> {
    const creature = this.creature(creatureId)
    const cardId = checkCardId(rawCardId)
    return this.serial(async () => {
      const sections = await this.mine(creature)
      const target = sectionId === null ? null : BbSectionsBackend.find(sections, sectionId)
      // The card must be a thread of this creature; moving another project's thread would hide it from both projects' views.
      const rows = await this.sdk.threads.list({ projectId: creature, threadIds: [cardId], includeHidden: true })
      const thread = rows.find((t) => t.id === cardId && t.projectId === creature)
      if (target === null) {
        // Unsorted means "in none of this creature's sections": a thread bb does not list, or one in no section of this creature
        // (including one the user filed in a section of their own), is already there.
        if (!thread || thread.sectionId === null || !sections.some((s) => s.id === thread.sectionId)) return
      } else if (!thread) {
        throw new SectionsError('not_found', `no such thread in this creature: ${cardId}`)
      }
      try {
        await this.sdk.threads.update({ threadId: cardId, sectionId: target === null ? null : target.id })
      } catch (e) {
        if (isNotFound(e)) throw new SectionsError('not_found', `no such thread or section: ${cardId}`)
        throw e
      }
    })
  }
}
