import { BbSectionsBackend, type BbSectionsSdk, scopedName } from './bb-backend'
import { SectionsError } from './types'

// A runtime check of the bb sections backend against the REAL bb SDK, to be called from inside the loaded plugin.
//
// It makes one throwaway section for one project (creature), walks it through create / duplicate / list / rename / move / delete, and
// reports every step. The one thread it moves is put back where it was, and the throwaway section is deleted even when a step fails.
// It touches nothing else. The panel installs it as `globalThis.__foundryBbSectionsCheck` (see panel.ts), so from the plugin's
// devtools console:
//
//   await __foundryBbSectionsCheck()                     // uses the most recently touched thread bb lists
//   await __foundryBbSectionsCheck({ threadId: 'thr_x' }) // or a thread you choose (its project is the creature)

export interface BbCheckStep { step: string; ok: boolean; detail: string; ms: number }
export interface BbCheckReport {
  ok: boolean
  /** The throwaway section's bb name, for finding it by hand if cleanup failed. */
  sectionName: string
  creature: string | null
  threadId: string | null
  steps: BbCheckStep[]
}
export interface BbCheckOptions {
  threadId?: string
  /** Injected for tests. */
  now?: () => number
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])

export async function runBbSectionsCheck(sdk: BbSectionsSdk, opts: BbCheckOptions = {}): Promise<BbCheckReport> {
  const now = opts.now ?? (() => Date.now())
  const stamp = now()
  const visible = `runtime-check ${stamp}`
  const report: BbCheckReport = { ok: true, sectionName: '', creature: null, threadId: null, steps: [] }

  const step = async <T>(name: string, fn: () => Promise<T>, detail: (v: T) => string, verify?: (v: T) => string | null): Promise<T | undefined> => {
    const t0 = now()
    try {
      const v = await fn()
      const problem = verify ? verify(v) : null
      report.steps.push({ step: name, ok: problem === null, detail: problem ?? detail(v), ms: now() - t0 })
      if (problem !== null) report.ok = false
      return v
    } catch (e) {
      report.ok = false
      report.steps.push({ step: name, ok: false, detail: e instanceof SectionsError ? `${e.code}: ${e.message}` : String(e instanceof Error ? `${e.name}: ${e.message}` : e), ms: now() - t0 })
      return undefined
    }
  }

  // 1. Pick the thread to move; its project is the creature the check runs in.
  const picked = await step(
    'pick thread',
    async () => {
      const rows = await sdk.threads.list(opts.threadId ? { threadIds: [opts.threadId], includeHidden: true } : { limit: 1 })
      const row = opts.threadId ? rows.find((r) => r.id === opts.threadId) : rows[0]
      if (!row) throw new Error(opts.threadId ? `bb does not list thread ${opts.threadId}` : 'bb lists no thread to move')
      return row
    },
    (r) => `${r.id} in project ${r.projectId}, section ${r.sectionId ?? 'none'}`,
  )
  if (!picked) return report
  report.creature = picked.projectId
  report.threadId = picked.id
  report.sectionName = scopedName(picked.projectId, visible)

  const backend = new BbSectionsBackend(sdk)
  const creature = picked.projectId
  let sectionId: string | null = null
  try {
    const before = await step('list', () => backend.list(creature), (s) => `${s.length} Foundry section(s) for this project`)
    if (!before) return report

    const made = await step('create', () => backend.create(creature, visible), (s) => `${s.id} as "${report.sectionName}"`,
      (s) => (s.name === visible && s.cardIds.length === 0 ? null : `unexpected result ${JSON.stringify(s)}`))
    if (!made) return report
    sectionId = made.id

    await step('create again, other case (the backend refuses it)', () => backend.create(creature, visible.toUpperCase()).then(
      () => { throw new Error('a second section with the same name (other case) was created') },
      (e: unknown) => {
        if (e instanceof SectionsError && e.code === 'duplicate_name') return 'duplicate_name'
        throw e
      },
    ), (v) => v)

    await step('create again, same name through the raw sdk (bb answers 409)', () => sdk.threadSections.create({ name: report.sectionName }).then(
      (row) => { throw new Error(`bb accepted a duplicate name and made ${row.id}`) },
      (e: unknown) => {
        const status = typeof e === 'object' && e !== null ? (e as { status?: unknown }).status : undefined
        if (status === 409) return 'HTTP 409'
        throw e
      },
    ), (v) => v)

    await step('list shows it', () => backend.list(creature), (s) => `${s.length} section(s)`,
      (s) => (s.some((x) => x.id === made.id && x.name === visible) && s.length === before.length + 1 ? null : 'the new section is missing, or the count is off'))

    const renamedName = `${visible} renamed`
    await step('rename', () => backend.rename(creature, made.id, renamedName), (s) => `now "${s.name}"`,
      (s) => (s.id === made.id && s.name === renamedName ? null : `unexpected result ${JSON.stringify(s)}`))

    await step('move thread in', async () => { await backend.moveCard(creature, picked.id, made.id); return backend.list(creature) },
      () => `${picked.id} is in the section`,
      (s) => (sameList(s.find((x) => x.id === made.id)?.cardIds ?? [], [picked.id]) ? null : 'the thread is not listed in the section after the move'))

    await step('move thread out', async () => { await backend.moveCard(creature, picked.id, null); return backend.list(creature) },
      () => `${picked.id} is Unsorted again`,
      (s) => ((s.find((x) => x.id === made.id)?.cardIds ?? []).length === 0 ? null : 'the thread is still in the section'))

    await step('move thread in, to see delete clear it', async () => { await backend.moveCard(creature, picked.id, made.id) }, () => 'moved')
  } finally {
    if (sectionId !== null) {
      const id = sectionId
      await step('delete', async () => {
        await backend.remove(creature, id)
        const [sections, threads] = await Promise.all([backend.list(creature), sdk.threads.list({ threadIds: [picked.id], includeHidden: true })])
        return { sections, thread: threads.find((r) => r.id === picked.id) }
      }, () => 'section deleted; the thread still exists with no section',
      ({ sections, thread }) => (sections.some((x) => x.id === id) ? 'the section is still listed after delete'
        : !thread ? 'the thread is gone after the section was deleted'
        : thread.sectionId !== null ? `the thread is still assigned to ${thread.sectionId}` : null))
    }
    // Delete clears assignments, so put the thread back where it was (a section of its own, or none) and check it still exists.
    await step('restore thread', async () => {
      await sdk.threads.update({ threadId: picked.id, sectionId: picked.sectionId })
      const rows = await sdk.threads.list({ threadIds: [picked.id], includeHidden: true })
      return rows.find((r) => r.id === picked.id)
    }, (r) => `${picked.id} back in ${r?.sectionId ?? 'no section'}`,
    (r) => (r === undefined ? 'the thread is gone after the section was deleted' : r.sectionId === picked.sectionId ? null : `the thread is in ${r.sectionId ?? 'no section'}, expected ${picked.sectionId ?? 'none'}`))
  }
  return report
}

/** One line per step, for a console or a log. */
export function formatBbCheck(r: BbCheckReport): string {
  const head = `bb sections check: ${r.ok ? 'PASS' : 'FAIL'} (project ${r.creature ?? '?'}, thread ${r.threadId ?? '?'}, section "${r.sectionName}")`
  return [head, ...r.steps.map((s) => `  ${s.ok ? 'ok  ' : 'FAIL'} ${s.step} - ${s.detail} (${s.ms} ms)`)].join('\n')
}
