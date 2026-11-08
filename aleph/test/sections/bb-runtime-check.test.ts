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

  it('fails when bb does not clear the assignment on delete', async () => {
    const bb = new FakeBb({ threads: [['t_1', 'proj1']] })
    const real = bb.threadSections.delete
    bb.threadSections.delete = async (a) => { const out = await real(a); bb.addThread('t_1', 'proj1', 'sec_ghost'); return out } // a bb that leaves the thread assigned
    const r = await runBbSectionsCheck(bb)
    expect(r.ok).toBe(false)
    expect(r.steps.find((s) => s.step === 'delete')?.detail).toMatch(/still assigned/)
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
