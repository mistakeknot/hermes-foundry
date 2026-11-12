import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EDIT_CHANNEL, EditBridge, toolText } from '../src/edit-bridge'
import { editContract } from '../src/edit-bridge-rpc'
import { runBridgedCall } from '../src/edit-bridge-panel'
import { AgentEdits } from '../src/agent-edits'
import { InspectorEdits } from '../src/inspector-edits'
import { MemorySectionsBackend } from '../src/sections/memory-backend'
import { MemoryLineageStore } from '../src/lineage/store'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

function bridge() {
  const sent: { channel: string; payload: any }[] = []
  let n = 0
  const b = new EditBridge((channel, payload) => sent.push({ channel, payload }), { newId: () => `c${++n}` })
  return { b, sent }
}
const call = { name: 'reroll_lineage', arguments: { projectId: 'p' } }

it('publishes the call and returns the result of the one pane that claims it', async () => {
  const { b, sent } = bridge()
  const out = b.call(call)
  expect(sent).toEqual([{ channel: EDIT_CHANNEL, payload: { callId: 'c1', call } }])
  expect(b.claim('c1', 'A')).toBe(true)
  expect(b.claim('c1', 'B')).toBe(false) // a second open pane must not run the edit again
  expect(b.report('c1', 'B', { ok: true, editId: 9 })).toBe(false) // only the claimer may report
  expect(b.report('c1', 'A', { ok: true, summary: 's', editId: 3 })).toBe(true)
  expect(await out).toMatchObject({ ok: true, editId: 1 }) // a bridge-wide handle, not the pane's own number
  expect(b.size).toBe(0)
  expect(b.report('c1', 'A', { ok: true })).toBe(false)
})

it('refuses unknown ids and a report that was never claimed', async () => {
  const { b } = bridge()
  expect(b.claim('nope', 'A')).toBe(false)
  const out = b.call(call)
  expect(b.report('c1', 'A', { ok: true })).toBe(false)
  vi.advanceTimersByTime(10_001)
  expect(await out).toMatchObject({ ok: false, error: { code: 'pane_unavailable' } })
  expect(b.size).toBe(0)
})

it('says the outcome is unknown when a pane claimed the edit but never reported, or the call is cancelled after the claim', async () => {
  const { b } = bridge()
  const out = b.call(call)
  b.claim('c1', 'A')
  vi.advanceTimersByTime(30_001)
  const r = await out
  expect(r).toMatchObject({ ok: false, error: { code: 'outcome_unknown' } })
  expect(toolText(r).text).toMatch(/^Not confirmed .*Check the pane before retrying/)
  const c = new AbortController()
  const out2 = b.call(call, c.signal)
  b.claim('c2', 'A')
  c.abort()
  const r2 = await out2
  expect(r2).toMatchObject({ error: { code: 'outcome_unknown' } })
  expect(toolText(r2).text).toMatch(/may have been applied/)
  expect(b.size).toBe(0)
})

it('settles on abort before a claim, including an already-aborted signal, and leaves nothing pending', async () => {
  const { b, sent } = bridge()
  const c = new AbortController()
  const out = b.call(call, c.signal)
  c.abort()
  expect(await out).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  expect(b.size).toBe(0)
  const done = AbortSignal.abort()
  expect(await b.call(call, done)).toMatchObject({ error: { code: 'cancelled' } })
  expect(b.size).toBe(0)
  expect(sent).toHaveLength(1) // the already-aborted call is never broadcast
})

it('routes an undo only to the pane that made the edit, even when two panes both numbered it 1', async () => {
  const { b, sent } = bridge()
  const a = b.call(call); b.claim('c1', 'A'); b.report('c1', 'A', { ok: true, editId: 1 })
  const bb = b.call(call); b.claim('c2', 'B'); b.report('c2', 'B', { ok: true, editId: 1 })
  const [ha, hb] = [(await a as any).editId, (await bb as any).editId]
  expect(ha).not.toBe(hb)
  const undo = b.call({ name: 'undo_edit', arguments: { editId: ha } })
  expect(sent.at(-1)!.payload).toEqual({ callId: 'c3', target: 'A', call: { name: 'undo_edit', arguments: { editId: 1 } } })
  expect(b.claim('c3', 'B')).toBe(false) // pane B must not take A's undo
  expect(b.claim('c3', 'A')).toBe(true)
  b.report('c3', 'A', { ok: true })
  expect(await undo).toMatchObject({ ok: true })
  const none = await b.call({ name: 'undo_edit', arguments: { editId: 999 } })
  expect(none).toMatchObject({ ok: false, error: { code: 'not_found' } })
  expect(sent).toHaveLength(3) // the unknown id was never broadcast
})

it('words results for the model without the project state', () => {
  expect(toolText({ ok: true, status: 'committed', editId: 4, summary: 'Moved t', state: { big: 1 } })).toEqual({ text: 'Done: Moved t. Undo with edit id 4.', isError: false })
  expect(toolText({ ok: true, status: 'committed_refresh_failed', editId: 5, summary: 'x' }).text).toMatch(/could not refresh/)
  expect(toolText({ ok: false, error: { code: 'not_found', message: 'No such section' } })).toEqual({ text: 'Not done (not_found): No such section', isError: true })
})

it('validates rpc inputs', () => {
  const v = (m: keyof typeof editContract, x: unknown) => (editContract[m].input['~standard'].validate(x) as any)
  expect(v('edit.claim', { callId: 'abc-1', paneId: 'p-1' }).value).toEqual({ callId: 'abc-1', paneId: 'p-1' })
  for (const bad of [null, [], {}, { callId: 5, paneId: 'p' }, { callId: 'a b', paneId: 'p' }, { callId: 'x'.repeat(65), paneId: 'p' }, { callId: 'a' }, { callId: 'a', paneId: 'p q' }]) expect(v('edit.claim', bad).issues).toBeTruthy()
  expect(v('edit.report', { callId: 'a', paneId: 'p', result: { ok: false } }).value).toMatchObject({ callId: 'a', paneId: 'p' })
  for (const bad of [{ callId: 'a', paneId: 'p' }, { callId: 'a', paneId: 'p', result: { ok: 'yes' } }, { callId: 'a', paneId: 'p', result: [] }, { callId: 'a', result: { ok: true } }]) expect(v('edit.report', bad).issues).toBeTruthy()
})

it('panel side: claims, dispatches through the real dispatcher, reports; a lost claim runs nothing', async () => {
  vi.useRealTimers()
  const sections = new MemorySectionsBackend()
  const s = await sections.create('p', 'Docs')
  const edits = new InspectorEdits(sections, new MemoryLineageStore())
  const tools = new AgentEdits(edits, () => ({ projects: [{ id: 'p' }], threads: [{ id: 't', projectId: 'p' }] }))
  await edits.refresh('p')
  const { b } = bridge()
  const rpc = {
    call: async (method: string, input: any) => method === 'edit.claim' ? b.claim(input.callId, input.paneId) : b.report(input.callId, input.paneId, input.result),
  } as any
  const out = b.call({ name: 'rename_section', arguments: { projectId: 'p', sectionId: s.id, name: 'Notes' } })
  const loser = runBridgedCall({ callId: 'c1', call: {} }, { dispatch: async () => { throw new Error('must not run') } } as any, { call: async () => false } as any, 'B')
  await runBridgedCall({ callId: 'c1', call: { name: 'rename_section', arguments: { projectId: 'p', sectionId: s.id, name: 'Notes' } } }, tools, rpc, 'A')
  await loser
  expect(await out).toMatchObject({ ok: true, status: 'committed' })
  expect(edits.project('p').sections[0].name).toBe('Notes')
  await expect(runBridgedCall({ callId: 'c1', call: {}, target: 'someone-else' }, { dispatch: async () => { throw new Error('must not run') } } as any, { call: async () => { throw new Error('must not claim') } } as any, 'A')).resolves.toBeUndefined() // an undo addressed to another pane is ignored
  await expect(runBridgedCall('junk', tools, rpc, 'A')).resolves.toBeUndefined()
  await expect(runBridgedCall({ callId: 'c9', call: null }, tools, { call: async () => { throw new Error('rpc down') } } as any, 'A')).resolves.toBeUndefined()
})
