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
  expect(b.claim('c1')).toBe(true)
  expect(b.claim('c1')).toBe(false) // a second open pane must not run the edit again
  expect(b.report('c1', { ok: true, summary: 's', editId: 3 })).toBe(true)
  expect(await out).toMatchObject({ ok: true, editId: 3 })
  expect(b.size).toBe(0)
  expect(b.report('c1', { ok: true })).toBe(false)
})

it('refuses unknown ids and a report that was never claimed', async () => {
  const { b } = bridge()
  expect(b.claim('nope')).toBe(false)
  const out = b.call(call)
  expect(b.report('c1', { ok: true })).toBe(false)
  vi.advanceTimersByTime(10_001)
  expect(await out).toMatchObject({ ok: false, error: { code: 'pane_unavailable' } })
  expect(b.size).toBe(0)
})

it('tells the model when a pane claimed the edit but never reported', async () => {
  const { b } = bridge()
  const out = b.call(call)
  b.claim('c1')
  vi.advanceTimersByTime(30_001)
  const r = await out
  expect(r).toMatchObject({ ok: false, error: { code: 'pane_unavailable' } })
  expect(toolText(r).text).toMatch(/Check the pane before retrying/)
})

it('settles on abort, including an already-aborted signal, and leaves nothing pending', async () => {
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

it('words results for the model without the project state', () => {
  expect(toolText({ ok: true, status: 'committed', editId: 4, summary: 'Moved t', state: { big: 1 } })).toEqual({ text: 'Done: Moved t. Undo with edit id 4.', isError: false })
  expect(toolText({ ok: true, status: 'committed_refresh_failed', editId: 5, summary: 'x' }).text).toMatch(/could not refresh/)
  expect(toolText({ ok: false, error: { code: 'not_found', message: 'No such section' } })).toEqual({ text: 'Not done (not_found): No such section', isError: true })
})

it('validates rpc inputs', () => {
  const v = (m: keyof typeof editContract, x: unknown) => (editContract[m].input['~standard'].validate(x) as any)
  expect(v('edit.claim', { callId: 'abc-1' }).value).toEqual({ callId: 'abc-1' })
  for (const bad of [null, [], {}, { callId: 5 }, { callId: 'a b' }, { callId: 'x'.repeat(65) }]) expect(v('edit.claim', bad).issues).toBeTruthy()
  expect(v('edit.report', { callId: 'a', result: { ok: false } }).value).toMatchObject({ callId: 'a' })
  for (const bad of [{ callId: 'a' }, { callId: 'a', result: { ok: 'yes' } }, { callId: 'a', result: [] }]) expect(v('edit.report', bad).issues).toBeTruthy()
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
    call: async (method: string, input: any) => method === 'edit.claim' ? b.claim(input.callId) : b.report(input.callId, input.result),
  } as any
  const out = b.call({ name: 'rename_section', arguments: { projectId: 'p', sectionId: s.id, name: 'Notes' } })
  const loser = runBridgedCall({ callId: 'c1', call: {} }, { dispatch: async () => { throw new Error('must not run') } } as any, { call: async () => false } as any)
  await runBridgedCall({ callId: 'c1', call: { name: 'rename_section', arguments: { projectId: 'p', sectionId: s.id, name: 'Notes' } } }, tools, rpc)
  await loser
  expect(await out).toMatchObject({ ok: true, status: 'committed' })
  expect(edits.project('p').sections[0].name).toBe('Notes')
  await expect(runBridgedCall('junk', tools, rpc)).resolves.toBeUndefined()
  await expect(runBridgedCall({ callId: 'c9', call: null }, tools, { call: async () => { throw new Error('rpc down') } } as any)).resolves.toBeUndefined()
})
