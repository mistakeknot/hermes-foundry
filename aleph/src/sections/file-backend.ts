import { randomBytes } from 'node:crypto'
import { constants as fsConstants, promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
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
  /**
   * The boards root (for Hermes, the kanban directory that holds `boards/`). When given, a board directory outside it, or reached
   * through a symlinked directory below it, is refused with `unsafe_path`. The root itself may be reached through a symlink.
   * Without it only the board directory itself is checked, so the caller's `boardDir` is trusted for the path above it.
   */
  trustedRoot?: string
}

function checkSlug(creatureId: string): void {
  if (typeof creatureId !== 'string' || !BOARD_SLUG.test(creatureId)) {
    throw new SectionsError('invalid_id', 'creature id must be a lowercase board slug (a-z, 0-9, "-", "_")')
  }
}

const unsafe = (what: string): SectionsError => new SectionsError('unsafe_path', `${what}; refusing to read or write through it`)
const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | undefined)?.code

/** Writers to one file are queued per process and keyed by the file's canonical path, so every backend instance in this process
 *  shares one queue per board file. Two processes writing the same file are not coordinated: the later rename wins. */
const queues = new Map<string, Promise<unknown>>()

class FileStore implements DocStore {
  constructor(private readonly opts: FileStoreOptions) {}

  /** The board's directory and sections file, or null if the board has no directory. Throws unsafe_path for a symlinked directory
   *  (the board's own, or, with a trusted root, any below the root). A check, not a lock: a concurrent swap can still race it. */
  private async locate(creatureId: string): Promise<{ dir: string; file: string; key: string } | null> {
    checkSlug(creatureId) // before any path is formed
    const dir = this.opts.boardDir(creatureId)
    for (const step of this.stepsBelowRoot(dir)) {
      const st = await fs.lstat(step).catch((e: unknown) => {
        if (errCode(e) === 'ENOENT' || errCode(e) === 'ENOTDIR') return null
        throw e
      })
      if (!st) return null
      if (st.isSymbolicLink()) throw unsafe(`${step === dir ? 'board directory' : 'a directory above the board'} is a symlink`)
      if (!st.isDirectory()) return null
    }
    const real = await fs.realpath(dir) // the queue key: aliases of one board (a symlinked ancestor) share a queue
    return { dir, file: path.join(dir, SECTIONS_FILENAME), key: path.join(real, SECTIONS_FILENAME) }
  }

  /** Every directory to check, root-most first, ending with the board directory itself. */
  private stepsBelowRoot(dir: string): string[] {
    const root = this.opts.trustedRoot
    if (root === undefined) return [dir]
    const rel = path.relative(path.resolve(root), path.resolve(dir))
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw unsafe('board directory is not inside the trusted root')
    const steps: string[] = []
    let cur = path.resolve(root)
    for (const part of rel.split(path.sep)) steps.push((cur = path.join(cur, part)))
    return steps
  }

  private async load(file: string): Promise<SectionsDoc> {
    const st = await fs.lstat(file).catch((e: unknown) => {
      if (errCode(e) === 'ENOENT' || errCode(e) === 'ENOTDIR') return null
      throw e
    })
    if (!st) return emptyDoc()
    if (!st.isFile()) throw unsafe('sections file is a symlink or not a regular file')
    let text: string
    try {
      const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
      try {
        if (!(await handle.stat()).isFile()) throw unsafe('sections file is not a regular file')
        text = await handle.readFile('utf8')
      } finally {
        await handle.close()
      }
    } catch (e) {
      if (errCode(e) === 'ELOOP') throw unsafe('sections file is a symlink')
      if (errCode(e) === 'ENOENT') return emptyDoc()
      throw e
    }
    let raw: unknown
    try { raw = JSON.parse(text) } catch { throw new SectionsError('corrupt', 'sections file is not valid JSON') }
    return parseDoc(raw)
  }

  async read(creatureId: string): Promise<SectionsDoc> {
    const where = await this.locate(creatureId)
    return where ? this.load(where.file) : emptyDoc() // a board with no directory simply has no sections
  }

  async update<T>(creatureId: string, fn: (doc: SectionsDoc) => Op<T>): Promise<T> {
    const where = await this.locate(creatureId) // throws invalid_id / unsafe_path before anything is written
    if (!where) throw new SectionsError('not_found', `board has no directory: ${creatureId}`) // never created here
    const { file, key } = where
    const run = async (): Promise<T> => {
      const { doc, result } = fn(await this.load(file)) // a corrupt file throws here: it is never overwritten
      await writeAtomic(file, JSON.stringify(doc, null, 2) + '\n')
      return result
    }
    const next = (queues.get(key) ?? Promise.resolve()).then(run, run)
    const tail = next.catch(() => undefined)
    queues.set(key, tail)
    void tail.then(() => { if (queues.get(key) === tail) queues.delete(key) })
    return next
  }
}

// Platforms that cannot flush a directory report one of these; anything else (EIO, ENOSPC, EACCES, ...) is a real failure.
const DIR_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR', ...(process.platform === 'win32' ? ['EPERM'] : [])])

/** Flush the directory entry the rename created, so the new file survives a power cut. Best effort only where the platform cannot. */
async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await fs.open(dir, fsConstants.O_RDONLY)
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (e) {
    if (!DIR_SYNC_UNSUPPORTED.has(errCode(e) ?? '')) throw e
  }
}

/**
 * Write to a temp file in the same directory, flush it, rename it over the target, then flush the directory: a reader sees the old
 * or the new file, never half, and the new one survives a power cut. On any failure before the rename the temp file is removed; a
 * crash (or a failed removal) can still leave a `.foundry-sections.json.*.tmp` file behind, which nothing reads and which is safe to delete.
 * An error from flushing the directory means the rename happened but its durability is unconfirmed.
 */
async function writeAtomic(file: string, text: string): Promise<void> {
  const dir = path.dirname(file)
  const tmp = path.join(dir, `.${SECTIONS_FILENAME}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  let handle: FileHandle | undefined = await fs.open(tmp, 'wx', 0o644) // a failure here created nothing, so nothing is removed
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    const opened = handle
    handle = undefined // closing is the next step: from here the handle is not closed a second time
    await opened.close()
    await fs.rename(tmp, file)
  } catch (e) {
    await handle?.close().catch(() => undefined)
    await fs.rm(tmp, { force: true })
    throw e
  }
  await syncDir(dir)
}

/** The Hermes sections backend: a Foundry file per board, beside the kanban. It never opens or writes the kanban database. */
export class FileSectionsBackend extends DocSectionsBackend {
  constructor(opts: FileStoreOptions, newId: () => string = randomSectionId) {
    super(new FileStore(opts), newId)
  }
}
