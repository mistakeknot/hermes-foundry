import { randomBytes } from 'node:crypto'
import { cloneSections, opCreate, opMoveCard, opRemove, opRename, type Op, type SectionsDoc } from './model'
import type { Section, SectionsBackend } from './types'

/** Where documents live. `update` is a serialised read-modify-write: it reads the creature's document, runs `fn`, and stores the result. */
export interface DocStore {
  read(creatureId: string): Promise<SectionsDoc>
  update<T>(creatureId: string, fn: (doc: SectionsDoc) => Op<T>): Promise<T>
}

export const randomSectionId = (): string => 's_' + randomBytes(4).toString('hex')

/** A SectionsBackend over any DocStore: all rules (names, one section per card, Unsorted) live in model.ts, shared by every store. */
export class DocSectionsBackend implements SectionsBackend {
  constructor(private readonly store: DocStore, private readonly newId: () => string = randomSectionId) {}

  async list(creatureId: string): Promise<Section[]> {
    return cloneSections((await this.store.read(creatureId)).sections)
  }
  create(creatureId: string, name: string): Promise<Section> {
    return this.store.update(creatureId, (doc) => opCreate(doc, name, this.newId))
  }
  rename(creatureId: string, sectionId: string, name: string): Promise<Section> {
    return this.store.update(creatureId, (doc) => opRename(doc, sectionId, name))
  }
  remove(creatureId: string, sectionId: string): Promise<void> {
    return this.store.update(creatureId, (doc) => opRemove(doc, sectionId))
  }
  moveCard(creatureId: string, cardId: string, sectionId: string | null): Promise<void> {
    return this.store.update(creatureId, (doc) => opMoveCard(doc, cardId, sectionId))
  }
}
