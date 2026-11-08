import { promises as fs, readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileSectionsBackend, SECTIONS_FILENAME, SectionsError } from '../../src/sections'
import { runSectionsContract } from './contract'

const KANBAN_BYTES = Buffer.from('SQLite format 3\0 pretend kanban database')
const boardDir = (root: string, slug: string): string => path.join(root, 'kanban', 'boards', slug)

/** A fake Hermes home with two boards that each hold a kanban.db. */
async function makeHome(slugs: string[] = ['atlas', 'harbor']): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-sections-'))
  for (const s of slugs) {
    await fs.mkdir(boardDir(root, s), { recursive: true })
    await fs.writeFile(path.join(boardDir(root, s), 'kanban.db'), KANBAN_BYTES)
  }
  return root
}
const backendFor = (root: string): FileSectionsBackend => new FileSectionsBackend({ boardDir: (s) => boardDir(root, s) })
const homes: string[] = []
async function home(slugs?: string[]): Promise<string> {
  const root = await makeHome(slugs)
  homes.push(root)
  return root
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const h of homes.splice(0)) await fs.rm(h, { recursive: true, force: true })
})

runSectionsContract('file backend', async () => {
  const root = await makeHome()
  return { backend: backendFor(root), creatures: ['atlas', 'harbor'], cleanup: () => fs.rm(root, { recursive: true, force: true }) }
})

describe('file backend', () => {
  it('keeps one file per board beside kanban.db, in the documented format', async () => {
    const root = await home()
    const b = backendFor(root)
    const docs = await b.create('atlas', 'Docs')
    await b.moveCard('atlas', 'atlas:t_1', docs.id)
    const file = path.join(boardDir(root, 'atlas'), SECTIONS_FILENAME)
    expect(SECTIONS_FILENAME).toBe('foundry-sections.json')
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ v: 1, sections: [{ id: docs.id, name: 'Docs', cardIds: ['atlas:t_1'] }] })
    await expect(fs.stat(path.join(boardDir(root, 'harbor'), SECTIONS_FILENAME))).rejects.toThrow() // another board is untouched
  })

  it('writes exactly the golden file the Python reader is also tested on', async () => {
    const root = await home()
    const ids = ['s_0a1b2c3d', 's_4e5f6a7b']
    const b = new FileSectionsBackend({ boardDir: (s) => boardDir(root, s) }, () => ids.shift()!)
    const docs = await b.create('atlas', 'Docs')
    const prep = await b.create('atlas', ' Release prep ')
    await b.moveCard('atlas', 'atlas:t_1', docs.id)
    await b.moveCard('atlas', 'atlas:t_2', docs.id)
    await b.moveCard('atlas', 'atlas:t_3', prep.id)
    await b.moveCard('atlas', 'atlas:t_3', null) // moved out again
    const written = await fs.readFile(path.join(boardDir(root, 'atlas'), SECTIONS_FILENAME), 'utf8')
    const golden = path.resolve(__dirname, '../../../tests/fixtures/sections/valid/written-by-backend.json')
    expect(written).toBe(await fs.readFile(golden, 'utf8'))
  })

  it('never touches the kanban database and leaves no temp file behind', async () => {
    const root = await home()
    const dir = boardDir(root, 'atlas')
    const before = await fs.stat(path.join(dir, 'kanban.db'))
    const b = backendFor(root)
    const s = await b.create('atlas', 'Docs')
    await b.moveCard('atlas', 'atlas:t_1', s.id)
    await b.rename('atlas', s.id, 'Documentation')
    await b.remove('atlas', s.id)
    const after = await fs.stat(path.join(dir, 'kanban.db'))
    expect(await fs.readFile(path.join(dir, 'kanban.db'))).toEqual(KANBAN_BYTES)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect((await fs.readdir(dir)).sort()).toEqual([SECTIONS_FILENAME, 'kanban.db'])
    expect(await fs.readdir(root)).toEqual(['kanban']) // nothing created beside the boards either
  })

  it('persists across backend instances', async () => {
    const root = await home()
    const made = await backendFor(root).create('atlas', 'Docs')
    expect(await backendFor(root).list('atlas')).toEqual([made])
  })

  it('reads a board with no file or no directory as having no sections, and a read creates nothing', async () => {
    const root = await home(['atlas'])
    const b = backendFor(root)
    expect(await b.list('atlas')).toEqual([])
    expect(await b.list('ghost')).toEqual([])
    expect(await fs.readdir(boardDir(root, 'atlas'))).toEqual(['kanban.db'])
    await expect(fs.stat(boardDir(root, 'ghost'))).rejects.toThrow()
  })

  it('refuses to write for a board that has no directory, and does not create it', async () => {
    const root = await home(['atlas'])
    const b = backendFor(root)
    await expect(b.create('ghost', 'Docs')).rejects.toMatchObject({ code: 'not_found' })
    await expect(b.moveCard('ghost', 'ghost:t_1', null)).rejects.toMatchObject({ code: 'not_found' })
    await expect(fs.stat(boardDir(root, 'ghost'))).rejects.toThrow()
  })

  it.each(['../atlas', 'atlas/../harbor', 'Atlas', '', '.', 'a b', 'atlas\0', 'x'.repeat(65)])('rejects the creature id %j before forming a path', async (bad) => {
    const asked: string[] = []
    const b = new FileSectionsBackend({ boardDir: (s) => { asked.push(s); return '/nonexistent' } })
    await expect(b.list(bad)).rejects.toMatchObject({ code: 'invalid_id' })
    await expect(b.create(bad, 'Docs')).rejects.toMatchObject({ code: 'invalid_id' })
    expect(asked).toEqual([])
  })

  it.each([
    ['not JSON', '{nope'],
    ['an unknown version', '{"v":2,"sections":[]}'],
    ['a card in two sections', '{"v":1,"sections":[{"id":"s_00000001","name":"A","cardIds":["x"]},{"id":"s_00000002","name":"B","cardIds":["x"]}]}'],
  ])('reports a corrupt file (%s) and never overwrites it', async (_why, text) => {
    const root = await home()
    const file = path.join(boardDir(root, 'atlas'), SECTIONS_FILENAME)
    await fs.writeFile(file, text)
    const b = backendFor(root)
    await expect(b.list('atlas')).rejects.toMatchObject({ code: 'corrupt' })
    await expect(b.create('atlas', 'Docs')).rejects.toMatchObject({ code: 'corrupt' })
    await expect(b.moveCard('atlas', 'x', null)).rejects.toMatchObject({ code: 'corrupt' })
    expect(await fs.readFile(file, 'utf8')).toBe(text)
  })

  it('leaves the old file intact and no temp file when the final rename fails', async () => {
    const root = await home()
    const b = backendFor(root)
    const first = await b.create('atlas', 'Docs')
    const dir = boardDir(root, 'atlas')
    const before = await fs.readFile(path.join(dir, SECTIONS_FILENAME), 'utf8')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk says no'))
    await expect(b.create('atlas', 'Ship')).rejects.toThrow('disk says no')
    expect(await fs.readFile(path.join(dir, SECTIONS_FILENAME), 'utf8')).toBe(before)
    expect((await fs.readdir(dir)).sort()).toEqual([SECTIONS_FILENAME, 'kanban.db'])
    expect(await b.list('atlas')).toEqual([first]) // and the queue is not stuck: the next write works
    expect((await b.create('atlas', 'Ship')).name).toBe('Ship')
  })

  it('a failed validation writes nothing', async () => {
    const root = await home()
    const b = backendFor(root)
    await expect(b.create('atlas', 'Unsorted')).rejects.toBeInstanceOf(SectionsError)
    await expect(fs.stat(path.join(boardDir(root, 'atlas'), SECTIONS_FILENAME))).rejects.toThrow()
  })

  it('serialises writers across backend instances on one board (no lost updates)', async () => {
    for (let round = 0; round < 5; round++) {
      const root = await home()
      const one = backendFor(root), two = backendFor(root)
      const names = ['A', 'B', 'C', 'D', 'E', 'F']
      await Promise.all(names.map((n, i) => (i % 2 ? two : one).create('atlas', n)))
      expect((await backendFor(root).list('atlas')).map((s) => s.name).sort()).toEqual(names)
    }
  })

  it('serialises writers that reach one board through different paths (an aliasing ancestor)', async () => {
    const root = await home()
    const alias = root + '-alias'
    await fs.symlink(root, alias)
    homes.push(alias)
    const one = backendFor(root), two = backendFor(alias)
    const names = ['A', 'B', 'C', 'D']
    await Promise.all(names.map((n, i) => (i % 2 ? two : one).create('atlas', n)))
    expect((await one.list('atlas')).map((s) => s.name).sort()).toEqual(names)
  })

  describe('symlinks', () => {
    async function outsideBoard(): Promise<{ root: string; outside: string }> {
      const root = await home([])
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-outside-'))
      homes.push(outside)
      await fs.mkdir(path.join(root, 'kanban', 'boards'), { recursive: true })
      await fs.symlink(outside, boardDir(root, 'atlas'))
      return { root, outside }
    }

    it('refuses a board directory that is a symlink, for reads and writes, and writes nothing through it', async () => {
      const { root, outside } = await outsideBoard()
      const b = backendFor(root)
      await expect(b.list('atlas')).rejects.toMatchObject({ code: 'unsafe_path' })
      await expect(b.create('atlas', 'Docs')).rejects.toMatchObject({ code: 'unsafe_path' })
      await expect(b.moveCard('atlas', 'atlas:t_1', null)).rejects.toMatchObject({ code: 'unsafe_path' })
      expect(await fs.readdir(outside)).toEqual([])
    })

    it('refuses a sections file that is a symlink and leaves its target alone', async () => {
      const root = await home()
      const target = path.join(root, 'elsewhere.json')
      await fs.writeFile(target, '{"v":1,"sections":[]}')
      await fs.symlink(target, path.join(boardDir(root, 'atlas'), SECTIONS_FILENAME))
      const b = backendFor(root)
      await expect(b.list('atlas')).rejects.toMatchObject({ code: 'unsafe_path' })
      await expect(b.create('atlas', 'Docs')).rejects.toMatchObject({ code: 'unsafe_path' })
      expect(await fs.readFile(target, 'utf8')).toBe('{"v":1,"sections":[]}')
      expect((await fs.lstat(path.join(boardDir(root, 'atlas'), SECTIONS_FILENAME))).isSymbolicLink()).toBe(true)
    })

    it('refuses a sections file that is not a regular file', async () => {
      const root = await home()
      await fs.mkdir(path.join(boardDir(root, 'atlas'), SECTIONS_FILENAME))
      await expect(backendFor(root).create('atlas', 'Docs')).rejects.toMatchObject({ code: 'unsafe_path' })
    })

    it('with a trusted root, refuses a symlinked directory anywhere between the root and the board', async () => {
      const root = await home([])
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-outside-'))
      homes.push(outside)
      await fs.mkdir(path.join(outside, 'atlas'))
      await fs.mkdir(path.join(root, 'kanban'), { recursive: true })
      await fs.symlink(outside, path.join(root, 'kanban', 'boards')) // an ancestor of the board directory
      const trusted = new FileSectionsBackend({ boardDir: (s) => boardDir(root, s), trustedRoot: path.join(root, 'kanban') })
      await expect(trusted.create('atlas', 'Docs')).rejects.toMatchObject({ code: 'unsafe_path' })
      await expect(trusted.list('atlas')).rejects.toMatchObject({ code: 'unsafe_path' })
      expect(await fs.readdir(path.join(outside, 'atlas'))).toEqual([])
    })

    it('with a trusted root, refuses a board directory outside it', async () => {
      const root = await home()
      const b = new FileSectionsBackend({ boardDir: (s) => boardDir(root, s), trustedRoot: path.join(root, 'other') })
      await expect(b.create('atlas', 'Docs')).rejects.toMatchObject({ code: 'unsafe_path' })
    })

    it('with a trusted root, still works for ordinary boards', async () => {
      const root = await home()
      const b = new FileSectionsBackend({ boardDir: (s) => boardDir(root, s), trustedRoot: path.join(root, 'kanban') })
      expect((await b.create('atlas', 'Docs')).name).toBe('Docs')
    })
  })

  describe('durability and cleanup', () => {
    const errno = (code: string): Error => Object.assign(new Error(code), { code })

    it('flushes the board directory after the rename', async () => {
      const root = await home()
      const dir = boardDir(root, 'atlas')
      const events: string[] = []
      const realOpen = fs.open.bind(fs), realRename = fs.rename.bind(fs)
      vi.spyOn(fs, 'rename').mockImplementation(async (...a) => { events.push('rename'); return realRename(...a) })
      vi.spyOn(fs, 'open').mockImplementation(async (...a: Parameters<typeof fs.open>) => {
        const h = await realOpen(...a)
        if (a[0] === dir) {
          const sync = h.sync.bind(h)
          h.sync = async () => { events.push('sync dir'); return sync() }
        }
        return h
      })
      await backendFor(root).create('atlas', 'Docs')
      expect(events).toEqual(['rename', 'sync dir'])
    })

    function failDirSync(dir: string, code: string): void {
      const realOpen = fs.open.bind(fs)
      vi.spyOn(fs, 'open').mockImplementation(async (...a: Parameters<typeof fs.open>) => {
        const h = await realOpen(...a)
        if (a[0] === dir) h.sync = async () => { throw errno(code) }
        return h
      })
    }

    it('surfaces a real error from flushing the directory', async () => {
      const root = await home()
      failDirSync(boardDir(root, 'atlas'), 'EIO')
      await expect(backendFor(root).create('atlas', 'Docs')).rejects.toMatchObject({ code: 'EIO' })
    })

    it('treats a platform that cannot flush a directory as best effort', async () => {
      const root = await home()
      failDirSync(boardDir(root, 'atlas'), 'ENOTSUP')
      expect((await backendFor(root).create('atlas', 'Docs')).name).toBe('Docs')
    })

    it('removes the temp file and keeps the old file when closing the temp file fails', async () => {
      const root = await home()
      const b = backendFor(root)
      await b.create('atlas', 'Docs')
      const dir = boardDir(root, 'atlas')
      const before = await fs.readFile(path.join(dir, SECTIONS_FILENAME), 'utf8')
      const realOpen = fs.open.bind(fs)
      vi.spyOn(fs, 'open').mockImplementation(async (...a: Parameters<typeof fs.open>) => {
        const h = await realOpen(...a)
        if (String(a[0]).endsWith('.tmp')) {
          const close = h.close.bind(h)
          h.close = async () => { await close(); throw errno('EIO') }
        }
        return h
      })
      await expect(b.create('atlas', 'Ship')).rejects.toMatchObject({ code: 'EIO' })
      expect((await fs.readdir(dir)).sort()).toEqual([SECTIONS_FILENAME, 'kanban.db'])
      expect(await fs.readFile(path.join(dir, SECTIONS_FILENAME), 'utf8')).toBe(before)
    })

    it('ignores a stale temp file left by a crash, and leaves it where it is', async () => {
      const root = await home()
      const dir = boardDir(root, 'atlas')
      const stale = path.join(dir, `.${SECTIONS_FILENAME}.4242.deadbeef.tmp`)
      await fs.writeFile(stale, '{"v":1,"sections":[{"id":"s_ffffffff","name":"Ghost","cardIds":[]}]}')
      const b = backendFor(root)
      expect(await b.list('atlas')).toEqual([])
      expect((await b.create('atlas', 'Docs')).name).toBe('Docs')
      expect((await b.list('atlas')).map((s) => s.name)).toEqual(['Docs'])
      expect(await fs.readdir(dir)).toContain(path.basename(stale))
    })
  })

  describe('bytes that are not valid UTF-8 (tests/fixtures/sections/invalid-bytes, also read by the Python tests)', () => {
    const dir = path.join(__dirname, '..', '..', '..', 'tests', 'fixtures', 'sections', 'invalid-bytes')
    const files = readdirSync(dir).filter((f) => f.endsWith('.bin')).sort()
    it('has fixtures', () => expect(files.length).toBeGreaterThanOrEqual(4))
    it.each(files)('%s: list and create fail as corrupt and the bytes are left unchanged', async (name) => {
      const root = await home()
      const target = path.join(boardDir(root, 'atlas'), SECTIONS_FILENAME)
      const bytes = readFileSync(path.join(dir, name))
      await fs.writeFile(target, bytes)
      const b = backendFor(root)
      await expect(b.list('atlas')).rejects.toMatchObject({ code: 'corrupt' })
      await expect(b.create('atlas', 'Docs')).rejects.toMatchObject({ code: 'corrupt' })
      expect(Buffer.compare(await fs.readFile(target), bytes)).toBe(0)
    })
  })

  // Known limit, not tested for because no pathname check can close it: the symlink and trustedRoot checks above run before the
  // file is opened, so a process that can swap a directory component in between can still redirect a write (Node has no openat).
  // They stop static misconfiguration and accidental redirects only; docs/sections-file.md has the threat model.
})
