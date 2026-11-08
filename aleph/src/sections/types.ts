// The sections interface: what any host's sections backend must offer, per creature (a creature is a project / board).
//
// Vocabulary: creature = project, section = limb (a bb sidebar section, a Foundry "epic"), card = thread / kanban task.
// "Unsorted" (cards in no section) is computed from the card list and the sections; it is never stored and never listed.
// Ids are opaque strings. A backend owns section ids; a card id is whatever the host calls a card.

export interface Section {
  id: string
  name: string
  /** Cards in this section, in the order they were moved in. A card is in at most one section of a creature.
   *  (The bb backend derives the order from each thread's last-touched time, so it is best-effort there: docs/sections-bb.md.) */
  cardIds: string[]
}

export type SectionsErrorCode =
  | 'invalid_id' // creature id or card id is malformed (for a file backend: not a board slug)
  | 'invalid_name' // empty, too long, control characters, a lone surrogate, or the reserved name "Unsorted"
  | 'duplicate_name' // another section of this creature has the name (compared case-insensitively)
  | 'not_found' // no such section, or (file backend, writes) the creature has no board directory, or (bb backend, moving a card INTO a section) no such thread in this creature
  | 'unsafe_path' // (file backend) the board directory or the sections file is a symlink or otherwise not what it must be; nothing is read or written through it
  | 'corrupt' // the stored data is not valid; a backend never overwrites it

export class SectionsError extends Error {
  readonly code: SectionsErrorCode
  constructor(code: SectionsErrorCode, message: string) {
    super(message)
    this.name = 'SectionsError'
    this.code = code
  }
}

export interface SectionsBackend {
  /** The creature's sections in creation order. A creature with none (or one the backend has never seen) lists []. */
  list(creatureId: string): Promise<Section[]>
  /** Add a section; the name is trimmed. Rejects invalid_name / duplicate_name. */
  create(creatureId: string, name: string): Promise<Section>
  /** Rename; renaming to the same name (or a different case of it) is allowed. Rejects not_found / invalid_name / duplicate_name. */
  rename(creatureId: string, sectionId: string, name: string): Promise<Section>
  /** Delete a section. Its cards become Unsorted; no card is deleted. Rejects not_found. */
  remove(creatureId: string, sectionId: string): Promise<void>
  /** Move a card into a section (appended), out of any other section; `null` moves it to Unsorted. Rejects not_found for an unknown section. */
  moveCard(creatureId: string, cardId: string, sectionId: string | null): Promise<void>
}
