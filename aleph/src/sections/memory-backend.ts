import { DocSectionsBackend, randomSectionId, type DocStore } from './doc-backend'
import { emptyDoc, type Op, type SectionsDoc } from './model'

class MemoryStore implements DocStore {
  private docs = new Map<string, SectionsDoc>()
  async read(creatureId: string): Promise<SectionsDoc> {
    return this.docs.get(creatureId) ?? emptyDoc()
  }
  async update<T>(creatureId: string, fn: (doc: SectionsDoc) => Op<T>): Promise<T> {
    const { doc, result } = fn(this.docs.get(creatureId) ?? emptyDoc()) // throws before anything is stored
    this.docs.set(creatureId, doc)
    return result
  }
}

/** Sections held in memory: for tests, previews, and a host with nowhere to store them. Accepts any creature id. */
export class MemorySectionsBackend extends DocSectionsBackend {
  constructor(newId: () => string = randomSectionId) {
    super(new MemoryStore(), newId)
  }
}
