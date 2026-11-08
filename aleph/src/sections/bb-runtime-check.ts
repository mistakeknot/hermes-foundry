import { BbSectionsBackend, type BbSectionMutation, type BbSectionsSdk, scopedName } from './bb-backend'
import { SectionsError } from './types'

// A runtime check of the bb sections backend against the REAL bb SDK, to be called from inside the loaded plugin.
//
// It makes a throwaway section for one project (creature), walks it through create / duplicate / list / move / rename / move / delete,
// and reports every step. It moves one real thread, and it puts that thread back FIRST: the original assignment is restored (with
// bounded retries and a read-back) before any throwaway section is deleted, so a failing restore can never leave the thread refiled.
// If the restore cannot be confirmed, the throwaway section is left in place and the report says so, with the thread's original
// section id so it can be put back by hand. Every section the check creates is tracked, including one a probe was not meant to make,
// and deleted at the end. The panel installs the check as `globalThis.__foundryBbSectionsCheck` (see panel.ts); from the plugin's
// devtools console:
//
//   await __foundryBbSectionsCheck()                     // uses the most recently touched thread bb lists
//   await __foundryBbSectionsCheck({ threadId: 'thr_x' }) // or a thread you choose (its project is the creature)
//
// Not exercised here: that deleting a section clears the assignments of its threads. That would need the real thread to be in the
// section when it is deleted, which is exactly the state this check refuses to risk; the fake in the tests covers it.

export interface BbCheckStep { step: string; ok: boolean; detail: string; ms: number }
export interface BbCheckRestore {
  /** The section the moved thread was in before the check (null: none). */
  originalSectionId: string | null
  attempts: number
  /** True only when a read-back showed the thread in its original section. */
  restored: boolean
  /** The last error or mismatch seen while restoring, if any attempt failed. */
  error?: string
}
export interface BbCheckReport {
  ok: boolean
  /** The throwaway section's bb name, for finding it by hand if cleanup failed. */
  sectionName: string
  creature: string | null
  threadId: string | null
  steps: BbCheckStep[]
  /** Set once the check has moved the thread. */
  restore: BbCheckRestore | null
  /** What `threadSections.update` reported as updatedThreadCount on the rename; null when the SDK returned none (which fails the rename step: the installed SDK requires the field). */
  renameUpdatedThreadCount: number | null
  /** Sections the check made and could not delete (by id and bb name). Empty when cleanup worked. */
  leftBehind: Array<{ id: string; name: string }>
}
export interface BbCheckOptions {
  threadId?: string
  /** How many times to try putting the thread back (default 3). */
  restoreAttempts?: number
  /** Injected for tests. */
  now?: () => number
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])
const message = (e: unknown): string => (e instanceof SectionsError ? `${e.code}: ${e.message}` : e instanceof Error ? `${e.name}: ${e.message}` : String(e))

export async function runBbSectionsCheck(sdk: BbSectionsSdk, opts: BbCheckOptions = {}): Promise<BbCheckReport> {
  const now = opts.now ?? (() => Date.now())
  const maxRestore = Math.max(1, opts.restoreAttempts ?? 3)
  const visible = `runtime-check ${now()}`
  const report: BbCheckReport = { ok: true, sectionName: '', creature: null, threadId: null, steps: [], restore: null, renameUpdatedThreadCount: null, leftBehind: [] }

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
      report.steps.push({ step: name, ok: false, detail: message(e), ms: now() - t0 })
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
  const creature = picked.projectId
  report.creature = creature
  report.threadId = picked.id
  report.sectionName = scopedName(creature, visible)

  // The backend sees the SDK through a spy that keeps the last rename result (the backend itself returns only a Section).
  let lastRename: BbSectionMutation | null = null
  const spied: BbSectionsSdk = {
    threads: sdk.threads,
    threadSections: {
      list: () => sdk.threadSections.list(),
      create: (a) => sdk.threadSections.create(a),
      delete: (a) => sdk.threadSections.delete(a),
      update: async (a) => { const r = await sdk.threadSections.update(a); lastRename = r; return r },
    },
  }
  const backend = new BbSectionsBackend(spied)

  /** Every section this run creates, by id, with its bb name; `main` is the one the walk-through uses. */
  const created = new Map<string, string>()
  let mainId: string | null = null
  let touched = false // set before the first attempt to move the thread

  try {
    const before = await step('list', () => backend.list(creature), (s) => `${s.length} Foundry section(s) for this project`)
    if (!before) return report

    const made = await step('create', () => backend.create(creature, visible), (s) => `${s.id} as "${report.sectionName}"`,
      (s) => (s.name === visible && s.cardIds.length === 0 ? null : `unexpected result ${JSON.stringify(s)}`))
    if (!made) return report
    mainId = made.id
    created.set(made.id, report.sectionName)

    await step('create again, other case (the backend refuses it)', () => backend.create(creature, visible.toUpperCase()).then(
      (s) => { created.set(s.id, scopedName(creature, s.name)); throw new Error(`a second section with the same name (other case) was created: ${s.id}`) },
      (e: unknown) => {
        if (e instanceof SectionsError && e.code === 'duplicate_name') return 'duplicate_name'
        throw e
      },
    ), (v) => v)

    await step('create again, same name through the raw sdk (bb answers 409)', () => sdk.threadSections.create({ name: report.sectionName }).then(
      (row) => { created.set(row.id, row.name); throw new Error(`bb accepted a duplicate name and made ${row.id}`) },
      (e: unknown) => {
        const status = typeof e === 'object' && e !== null ? (e as { status?: unknown }).status : undefined
        if (status === 409) return 'HTTP 409'
        throw e
      },
    ), (v) => v)

    await step('list shows it', () => backend.list(creature), (s) => `${s.length} section(s)`,
      (s) => (s.some((x) => x.id === made.id && x.name === visible) && s.length === before.length + 1 ? null : 'the new section is missing, or the count is off'))

    touched = true
    await step('move thread in', async () => { await backend.moveCard(creature, picked.id, made.id); return backend.list(creature) },
      () => `${picked.id} is in the section`,
      (s) => (sameList(s.find((x) => x.id === made.id)?.cardIds ?? [], [picked.id]) ? null : 'the thread is not listed in the section after the move'))

    // Renamed while the thread is in it, so bb's updatedThreadCount should be 1.
    const renamedName = `${visible} renamed`
    await step('rename', async () => { lastRename = null; return backend.rename(creature, made.id, renamedName) },
      (s) => {
        const n = (lastRename as BbSectionMutation | null)?.updatedThreadCount
        return `now "${s.name}"; bb reports updatedThreadCount ${String(n)}`
      },
      (s) => {
        if (s.id !== made.id || s.name !== renamedName) return `unexpected result ${JSON.stringify(s)}`
        if (!sameList(s.cardIds, [picked.id])) return 'the thread is not in the section after the rename'
        const n = (lastRename as BbSectionMutation | null)?.updatedThreadCount
        report.renameUpdatedThreadCount = typeof n === 'number' ? n : null
        return n === 1 ? null : `bb reports updatedThreadCount ${n === undefined ? 'nothing' : JSON.stringify(n)}, expected 1`
      })

    await step('move thread out', async () => { await backend.moveCard(creature, picked.id, null); return backend.list(creature) },
      () => `${picked.id} is Unsorted again`,
      (s) => ((s.find((x) => x.id === made.id)?.cardIds ?? []).length === 0 ? null : 'the thread is still in the section'))
  } finally {
    // 2. Put the thread back BEFORE deleting anything, and only delete the throwaway section once the thread is confirmed back.
    if (touched) {
      const r: BbCheckRestore = { originalSectionId: picked.sectionId, attempts: 0, restored: false }
      report.restore = r
      await step('restore thread', async () => {
        while (r.attempts < maxRestore && !r.restored) {
          r.attempts++
          try {
            await sdk.threads.update({ threadId: picked.id, sectionId: picked.sectionId })
            const rows = await sdk.threads.list({ threadIds: [picked.id], includeHidden: true })
            const row = rows.find((x) => x.id === picked.id)
            if (row && row.sectionId === picked.sectionId) r.restored = true
            else r.error = row ? `read back section ${row.sectionId ?? 'none'}, expected ${picked.sectionId ?? 'none'}` : 'the thread is not listed after the update'
          } catch (e) {
            r.error = message(e)
          }
        }
        return r
      }, (x) => `${picked.id} back in ${x.originalSectionId ?? 'no section'} (attempt ${x.attempts})`,
      (x) => (x.restored ? null : `could not restore ${picked.id} to ${x.originalSectionId ?? 'no section'} after ${x.attempts} attempt(s): ${x.error ?? 'unknown'}; its original section id is ${x.originalSectionId ?? 'none'}`))
    }

    // 3. Delete every section this run made (the main one only if the thread is safely back).
    for (const [id, name] of created) {
      const isMain = id === mainId
      if (isMain && touched && !report.restore?.restored) {
        report.leftBehind.push({ id, name })
        report.steps.push({ step: 'delete', ok: false, detail: `left ${id} ("${name}") in place because the thread was not confirmed restored; delete it by hand after fixing the thread`, ms: 0 })
        report.ok = false
        continue
      }
      const ok = await step(isMain ? 'delete' : `delete stray section ${id}`, async () => {
        await backend.remove(creature, id)
        return backend.list(creature)
      }, () => `${id} deleted`, (s) => (s.some((x) => x.id === id) ? `${id} is still listed after delete` : null))
      if (ok === undefined || ok.some((x) => x.id === id)) report.leftBehind.push({ id, name })
    }

    if (touched && report.restore?.restored) {
      await step('thread intact after cleanup', async () => (await sdk.threads.list({ threadIds: [picked.id], includeHidden: true })).find((x) => x.id === picked.id),
        () => `${picked.id} still exists in ${picked.sectionId ?? 'no section'}`,
        (t) => (t === undefined ? 'the thread is gone after the cleanup' : t.sectionId === picked.sectionId ? null : `the thread is in ${t.sectionId ?? 'no section'}, expected ${picked.sectionId ?? 'none'}`))
    }
  }
  return report
}

/** One line per step, for a console or a log. */
export function formatBbCheck(r: BbCheckReport): string {
  const head = `bb sections check: ${r.ok ? 'PASS' : 'FAIL'} (project ${r.creature ?? '?'}, thread ${r.threadId ?? '?'}, section "${r.sectionName}")`
  const tail = r.leftBehind.length ? [`  LEFT BEHIND: ${r.leftBehind.map((x) => `${x.id} "${x.name}"`).join(', ')}`] : []
  return [head, ...r.steps.map((s) => `  ${s.ok ? 'ok  ' : 'FAIL'} ${s.step} - ${s.detail} (${s.ms} ms)`), ...tail].join('\n')
}
