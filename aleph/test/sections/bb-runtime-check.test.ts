import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHECK_GLOBAL, formatBbCheck, installBbSectionsCheck, runBbSectionsCheck } from '../../src/sections'
import { FakeBb, FakeBbHttpError } from './fake-bb'

const names = (r: { steps: { step: string }[] }) => r.steps.map((s) => s.step)

describe('runBbSectionsCheck', () => {
  it('passes against a faithful bb, leaves no section behind and restores the thread', async () => {
    const bb = new FakeBb({ threads: [['t_1', 'proj1']] })
    const keep = bb.addSection('Reading list')
    bb.addThread('t_2', 'proj1', keep.id)
    const r = await runBbSectionsCheck(bb, { threadId: 't_2' })
    expect(r.ok).toBe(true)
    expect(r.steps.every((s) => s.ok)).toBe(true)
    expect(names(r)).toEqual(expect.arrayContaining(['pick thread', 'create', 'list shows it', 'rename', 'move thread in', 'move thread out', 'delete', 'restore thread']))
    expect(bb.rawSections().map((s) => s.name)).toEqual(['Reading list'])
    expect(bb.rawThread('t_2')?.sectionId).toBe(keep.id) // back in the section it was in
    expect(formatBbCheck(r)).toMatch(/^bb sections check: PASS/)
  })

  it('picks the first listed thread when none is named', async () => {
    const bb = new FakeBb({ threads: [['t_1', 'proj1']] })
    const r = await runBbSectionsCheck(bb)
    expect(r).toMatchObject({ ok: true, creature: 'proj1', threadId: 't_1' })
  })

  it('reports a missing thread and stops', async () => {
    const r = await runBbSectionsCheck(new FakeBb(), { threadId: 'nope' })
    expect(r.ok).toBe(false)
    expect(r.steps).toHaveLength(1)
    expect(r.steps[0]).toMatchObject({ step: 'pick thread', ok: false })
  })

  it('reports a failing step, still deletes the throwaway section and restores the thread', async () => {
    const bb = new FakeBb({ threads: [['t_1', 'proj1']] })
    bb.failNext.set('threadSections.update', new FakeBbHttpError(500, 'internal', 'boom'))
    const r = await runBbSectionsCheck(bb)
    expect(r.ok).toBe(false)
    expect(r.steps.find((s) => s.step === 'rename')).toMatchObject({ ok: false })
    expect(r.steps.find((s) => s.step === 'delete')).toMatchObject({ ok: true })
    expect(bb.rawSections()).toEqual([])
    expect(formatBbCheck(r)).toMatch(/FAIL/)
  })

  it('restores the thread BEFORE it deletes the throwaway section', async () => {
    const bb = new FakeBb({ threads: [['t_1', 'proj1']] })
    const keep = bb.addSection('Reading list')
    bb.addThread('t_2', 'proj1', keep.id)
    await runBbSectionsCheck(bb, { threadId: 't_2' })
    const restoreAt = bb.calls.lastIndexOf('threads.update')
    const deleteAt = bb.calls.indexOf('threadSections.delete')
    expect(restoreAt).toBeGreaterThan(-1)
    expect(restoreAt).toBeLessThan(deleteAt)
  })

  it('reports the rename updatedThreadCount', async () => {
    const r = await runBbSectionsCheck(new FakeBb({ threads: [['t_1', 'proj1']] }))
    expect(r).toMatchObject({ ok: true, renameUpdatedThreadCount: 0 })
    expect(r.steps.find((s) => s.step === 'rename')?.detail).toMatch(/updatedThreadCount 0/)
  })

  it.each([['missing', undefined], ['non-numeric', '1']])('fails the rename step when updatedThreadCount is %s, and still cleans up', async (_label, bad) => {
    const bb = new FakeBb({ threads: [['t_1', 'proj1']] })
    const real = bb.threadSections.update
    bb.threadSections.update = async (a) => { const { id, name } = await real(a); return { id, name, updatedThreadCount: bad } as never }
    const r = await runBbSectionsCheck(bb)
    expect(r.ok).toBe(false)
    expect(r.renameUpdatedThreadCount).toBeNull()
    expect(r.steps.find((s) => s.step === 'rename')).toMatchObject({ ok: false, detail: expect.stringMatching(/whole number of 0 or more/) })
    expect(bb.rawSections()).toEqual([])
    expect(r.leftBehind).toEqual([])
  })

  it.each([[-1], [1.5]])('fails the rename step when updatedThreadCount is %s', async (bad) => {
    const bb = new FakeBb({ threads: [['t_1', 'proj1']] })
    const real = bb.threadSections.update
    bb.threadSections.update = async (a) => ({ ...(await real(a)), updatedThreadCount: bad })
    const r = await runBbSectionsCheck(bb)
    expect(r.ok).toBe(false)
    expect(r.renameUpdatedThreadCount).toBe(bad)
    expect(r.steps.find((s) => s.step === 'rename')).toMatchObject({ ok: false })
    expect(bb.rawSections()).toEqual([]) // still cleaned up
  })

  it('accepts any whole updatedThreadCount of 0 or more', async () => {
    const bb = new FakeBb({ threads: [['t_1', 'proj1']] })
    const real = bb.threadSections.update
    bb.threadSections.update = async (a) => ({ ...(await real(a)), updatedThreadCount: 3 })
    const r = await runBbSectionsCheck(bb)
    expect(r).toMatchObject({ ok: true, renameUpdatedThreadCount: 3 })
  })

  describe('when putting the thread back fails', () => {
    // The thread starts in a section of the user's own, so the restore is the only update that names that section.
    const setup = () => {
      const bb = new FakeBb({ threads: [['t_1', 'proj1']] })
      const keep = bb.addSection('Reading list')
      bb.addThread('t_2', 'proj1', keep.id)
      return { bb, keep }
    }
    const failRestore = (bb: FakeBb, keepId: string, times: number) => {
      const real = bb.threads.update
      let left = times
      bb.threads.update = async (a) => {
        if (a.sectionId === keepId && left-- > 0) throw new FakeBbHttpError(503, 'unavailable', 'try later')
        return real(a)
      }
    }

    it('retries a transient failure, then deletes the section', async () => {
      const { bb, keep } = setup()
      failRestore(bb, keep.id, 1)
      const r = await runBbSectionsCheck(bb, { threadId: 't_2' })
      expect(r.ok).toBe(true)
      expect(r.restore).toEqual({ originalSectionId: keep.id, attempts: 2, restored: true, error: expect.stringContaining('try later') })
      expect(bb.rawThread('t_2')?.sectionId).toBe(keep.id)
      expect(bb.rawSections().map((x) => x.name)).toEqual(['Reading list'])
      expect(r.leftBehind).toEqual([])
    })

    it('on a permanent failure keeps the throwaway section, never refiles the thread, and says how to put it back', async () => {
      const { bb, keep } = setup()
      failRestore(bb, keep.id, Infinity)
      const r = await runBbSectionsCheck(bb, { threadId: 't_2', restoreAttempts: 3 })
      expect(r.ok).toBe(false)
      expect(r.restore).toMatchObject({ originalSectionId: keep.id, attempts: 3, restored: false })
      expect(bb.calls).not.toContain('threadSections.delete') // deleting would have cleared the real assignment for good
      expect(r.leftBehind).toEqual([{ id: expect.stringMatching(/^sec_/), name: r.sectionName }])
      expect(r.steps.find((x) => x.step === 'restore thread')?.detail).toContain(`original section id is ${keep.id}`)
      expect(formatBbCheck(r)).toMatch(/LEFT BEHIND/)
    })

    it('does not trust an update that did not take (read-back mismatch)', async () => {
      const { bb, keep } = setup()
      const real = bb.threads.update
      bb.threads.update = async (a) => (a.sectionId === keep.id ? { id: a.threadId } : real(a)) // 200 OK, nothing changed
      const r = await runBbSectionsCheck(bb, { threadId: 't_2', restoreAttempts: 2 })
      expect(r.ok).toBe(false)
      expect(r.restore).toMatchObject({ restored: false, attempts: 2 })
      expect(r.restore?.error).toMatch(/read back section/)
      expect(r.leftBehind).toHaveLength(1)
    })
  })

  it('tracks and deletes a section the raw duplicate probe unexpectedly creates', async () => {
    const bb = new FakeBb({ threads: [['t_1', 'proj1']] })
    const real = bb.threadSections.create
    let first = true
    bb.threadSections.create = async (a) => {
      if (!first && bb.rawSections().some((x) => x.name === a.name)) return bb.addSection(a.name) // a bb that accepts the duplicate
      first = false
      return real(a)
    }
    const r = await runBbSectionsCheck(bb)
    expect(r.ok).toBe(false)
    expect(r.steps.find((x) => x.step.startsWith('create again, same name through the raw sdk'))).toMatchObject({ ok: false })
    expect(r.steps.some((x) => x.step.startsWith('delete stray section') && x.ok)).toBe(true)
    expect(bb.rawSections()).toEqual([]) // neither the throwaway nor the stray one leaks
    expect(r.leftBehind).toEqual([])
  })

  it('reports a section it could not delete', async () => {
    const bb = new FakeBb({ threads: [['t_1', 'proj1']] })
    bb.failNext.set('threadSections.delete', new FakeBbHttpError(500, 'internal', 'boom'))
    const r = await runBbSectionsCheck(bb)
    expect(r.ok).toBe(false)
    expect(r.leftBehind).toHaveLength(1)
    expect(bb.rawThread('t_1')?.sectionId).toBeNull() // the thread was restored first
  })
})

describe('installBbSectionsCheck', () => {
  afterEach(() => vi.restoreAllMocks())

  it('installs a console entry point that logs the report, and removes only its own on cleanup', async () => {
    const target: Record<string, unknown> = {}
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const off = installBbSectionsCheck(new FakeBb({ threads: [['t_1', 'proj1']] }), target)
    const fn = target[CHECK_GLOBAL] as () => Promise<{ ok: boolean }>
    expect((await fn()).ok).toBe(true)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('PASS'))
    target[CHECK_GLOBAL] = 'someone else'
    off()
    expect(target[CHECK_GLOBAL]).toBe('someone else')
  })

  it('installs nothing for an sdk without the sections api', () => {
    const target: Record<string, unknown> = {}
    installBbSectionsCheck({} as never, target)()
    installBbSectionsCheck(undefined, target)()
    expect(target).toEqual({})
  })
})
