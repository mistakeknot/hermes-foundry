import { SectionsError, type Section } from './types'

// The stored document and the pure rules every backend shares, so the memory and file backends cannot drift apart.
// Rules for the Python reader (foundry_core/sections.py) are the same; tests/fixtures/sections/ is checked by both.

export const NAME_MAX = 80
export const CARD_ID_MAX = 200
export const RESERVED_NAME = 'unsorted'
export const SECTION_ID = /^s_[0-9a-f]{8}$/

export interface SectionsDoc {
  v: 1
  sections: Section[]
}

export const emptyDoc = (): SectionsDoc => ({ v: 1, sections: [] })

const CONTROL = /[\u0000-\u001f\u007f]/
const nameKey = (name: string): string => name.toLowerCase()

/** A section name as stored: trimmed, 1..80 chars, no control characters, not "Unsorted". Throws invalid_name. */
export function normalizeName(raw: unknown): string {
  if (typeof raw !== 'string') throw new SectionsError('invalid_name', 'section name must be a string')
  const name = raw.trim()
  if (!name) throw new SectionsError('invalid_name', 'section name is empty')
  if (name.length > NAME_MAX) throw new SectionsError('invalid_name', `section name is longer than ${NAME_MAX} characters`)
  if (CONTROL.test(name)) throw new SectionsError('invalid_name', 'section name has control characters')
  if (nameKey(name) === RESERVED_NAME) throw new SectionsError('invalid_name', '"Unsorted" is reserved: it is computed, not a section')
  return name
}

export function checkCardId(raw: unknown): string {
  if (typeof raw !== 'string' || !raw || raw.length > CARD_ID_MAX || CONTROL.test(raw)) {
    throw new SectionsError('invalid_id', 'card id must be a non-empty string of at most 200 characters, without control characters')
  }
  return raw
}

export function cloneSections(sections: readonly Section[]): Section[] {
  return sections.map((s) => ({ id: s.id, name: s.name, cardIds: [...s.cardIds] }))
}

/** Validate untrusted JSON as a v1 document (strict: unknown keys, duplicates and unnormalised names are corrupt). Throws corrupt. */
export function parseDoc(raw: unknown): SectionsDoc {
  const bad = (why: string): never => { throw new SectionsError('corrupt', `sections file is not valid: ${why}`) }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad('not an object')
  const top = raw as Record<string, unknown>
  if (Object.keys(top).some((k) => k !== 'v' && k !== 'sections')) bad('unknown key')
  if (top.v !== 1) bad('unsupported version')
  if (!Array.isArray(top.sections)) return bad('sections is not a list')
  const ids = new Set<string>(), names = new Set<string>(), cards = new Set<string>()
  const sections: Section[] = top.sections.map((item: unknown): Section => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return bad('a section is not an object')
    const s = item as Record<string, unknown>
    if (Object.keys(s).some((k) => k !== 'id' && k !== 'name' && k !== 'cardIds')) bad('unknown section key')
    if (typeof s.id !== 'string' || !SECTION_ID.test(s.id)) return bad('bad section id')
    if (ids.has(s.id)) bad('duplicate section id')
    ids.add(s.id)
    let name: string
    try { name = normalizeName(s.name) } catch { return bad('bad section name') }
    if (name !== s.name) bad('section name is not trimmed')
    if (names.has(nameKey(name))) bad('duplicate section name')
    names.add(nameKey(name))
    if (!Array.isArray(s.cardIds)) return bad('cardIds is not a list')
    const cardIds = s.cardIds.map((c: unknown) => {
      let id: string
      try { id = checkCardId(c) } catch { return bad('bad card id') }
      if (cards.has(id)) bad('a card is in two sections')
      cards.add(id)
      return id
    })
    return { id: s.id, name, cardIds }
  })
  return { v: 1, sections }
}

// -- pure operations: each takes a document and returns the next one plus a result; a document is never mutated -------

export interface Op<T> { doc: SectionsDoc; result: T }

const find = (doc: SectionsDoc, id: string): Section => {
  const s = doc.sections.find((x) => x.id === id)
  if (!s) throw new SectionsError('not_found', `no such section: ${id}`)
  return s
}

const checkUnique = (doc: SectionsDoc, name: string, exceptId: string | null): void => {
  if (doc.sections.some((s) => s.id !== exceptId && nameKey(s.name) === nameKey(name))) {
    throw new SectionsError('duplicate_name', `a section named "${name}" already exists`)
  }
}

export function opCreate(doc: SectionsDoc, rawName: string, newId: () => string): Op<Section> {
  const name = normalizeName(rawName)
  checkUnique(doc, name, null)
  let id = newId()
  for (let i = 0; doc.sections.some((s) => s.id === id); i++) {
    if (i > 50) throw new Error('could not allocate a section id')
    id = newId()
  }
  const section: Section = { id, name, cardIds: [] }
  return { doc: { v: 1, sections: [...cloneSections(doc.sections), section] }, result: { ...section, cardIds: [] } }
}

export function opRename(doc: SectionsDoc, id: string, rawName: string): Op<Section> {
  find(doc, id)
  const name = normalizeName(rawName)
  checkUnique(doc, name, id)
  const sections = cloneSections(doc.sections)
  const s = sections.find((x) => x.id === id)!
  s.name = name
  return { doc: { v: 1, sections }, result: { ...s, cardIds: [...s.cardIds] } }
}

export function opRemove(doc: SectionsDoc, id: string): Op<void> {
  find(doc, id)
  return { doc: { v: 1, sections: cloneSections(doc.sections.filter((s) => s.id !== id)) }, result: undefined }
}

export function opMoveCard(doc: SectionsDoc, rawCardId: string, sectionId: string | null): Op<void> {
  const cardId = checkCardId(rawCardId)
  if (sectionId !== null) find(doc, sectionId)
  const sections = cloneSections(doc.sections)
  for (const s of sections) s.cardIds = s.cardIds.filter((c) => c !== cardId)
  if (sectionId !== null) sections.find((s) => s.id === sectionId)!.cardIds.push(cardId)
  return { doc: { v: 1, sections }, result: undefined }
}

// -- Unsorted: computed, never stored -----------------------------------------------------------------------------

/** The cards (in the given order) that are in none of the sections. A stored card id that is not in `allCardIds` is ignored. */
export function unsortedCards(sections: readonly Section[], allCardIds: readonly string[]): string[] {
  const sorted = new Set(sections.flatMap((s) => s.cardIds))
  return allCardIds.filter((c) => !sorted.has(c))
}
