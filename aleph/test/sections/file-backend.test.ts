import { promises as fs } from 'node:fs'
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
})
