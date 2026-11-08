import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DocSectionsBackend, randomSectionId, type DocStore } from './doc-backend'
import { emptyDoc, parseDoc, type Op, type SectionsDoc } from './model'
import { SectionsError } from './types'

/** One file per board, beside the kanban database. Format: docs/sections-file.md. */
export const SECTIONS_FILENAME = 'foundry-sections.json'
/** Hermes's canonical board slug; checked before any path is formed. */
export const BOARD_SLUG = /^[a-z0-9][a-z0-9\-_]{0,63}$/

export interface FileStoreOptions {
  /** Maps a board slug to its existing Hermes board directory (the one holding kanban.db). Never asked about anything but a valid slug. */
  boardDir: (creatureId: string) => string
}

function checkSlug(creatureId: string): void {
  if (typeof creatureId !== 'string' || !BOARD_SLUG.test(creatureId)) {
    throw new SectionsError('invalid_id', 'creature id must be a lowercase board slug (a-z, 0-9, "-", "_")')
  }
}

const isDir = async (p: string): Promise<boolean> => (await fs.stat(p).catch(() => null))?.isDirectory() ?? false

class FileStore implements DocStore {
  // Writers to one file are queued in this process, so two updates never interleave their read and write.
  // Two processes writing the same file are not coordinated: the later rename wins (see docs/sections-file.md).
  private queues = new Map<string, Promise<unknown>>()
  constructor(private readonly opts: FileStoreOptions) {}

  private file(creatureId: string): { dir: string; file: string } {
    checkSlug(creatureId)
    const dir = this.opts.boardDir(creatureId)
    return { dir, file: path.join(dir, SECTIONS_FILENAME) }
  }

  private async load(file: string): Promise<SectionsDoc> {
    let text: string
    try {
      text = await fs.readFile(file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return emptyDoc()
      throw e
    }
    let raw: unknown
    try { raw = JSON.parse(text) } catch { throw new SectionsError('corrupt', 'sections file is not valid JSON') }
    return parseDoc(raw)
  }

  async read(creatureId: string): Promise<SectionsDoc> {
    return this.load(this.file(creatureId).file) // a board with no file (or no directory) simply has no sections
  }

  async update<T>(creatureId: string, fn: (doc: SectionsDoc) => Op<T>): Promise<T> {
    const { dir, file } = this.file(creatureId) // throws invalid_id before any path is used
    const run = async (): Promise<T> => {
      if (!(await isDir(dir))) throw new SectionsError('not_found', `board has no directory: ${creatureId}`) // never created here
      const { doc, result } = fn(await this.load(file)) // a corrupt file throws here: it is never overwritten
      await writeAtomic(file, JSON.stringify(doc, null, 2) + '\n')
      return result
    }
    const next = (this.queues.get(file) ?? Promise.resolve()).then(run, run)
    const tail = next.catch(() => undefined)
    this.queues.set(file, tail)
    void tail.then(() => { if (this.queues.get(file) === tail) this.queues.delete(file) })
    return next
  }
}

/** Write to a temp file in the same directory, flush it, then rename over the target: a reader sees the old or the new file, never half. */
async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${SECTIONS_FILENAME}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  const handle = await fs.open(tmp, 'wx', 0o644)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } catch (e) {
    await handle.close().catch(() => undefined)
    await fs.rm(tmp, { force: true })
    throw e
  }
  await handle.close()
  try {
    await fs.rename(tmp, file)
  } catch (e) {
    await fs.rm(tmp, { force: true })
    throw e
  }
}

/** The Hermes sections backend: a Foundry file per board, beside the kanban. It never opens or writes the kanban database. */
export class FileSectionsBackend extends DocSectionsBackend {
  constructor(opts: FileStoreOptions, newId: () => string = randomSectionId) {
    super(new FileStore(opts), newId)
  }
}
