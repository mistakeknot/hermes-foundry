import type { AgentEditSurface } from './agent-edits'

interface Rpc {
  call(method: 'edit.claim', input: { callId: string }): Promise<boolean>
  call(method: 'edit.report', input: { callId: string; result: { ok: boolean } }): Promise<boolean>
}
/** Handle one `edit.call` broadcast: claim it (only one open pane may run it), dispatch, report. Never throws. */
export async function runBridgedCall(payload: unknown, tools: AgentEditSurface, rpc: Rpc): Promise<void> {
  if (!payload || typeof payload !== 'object') return
  const { callId, call } = payload as { callId?: unknown; call?: unknown }
  if (typeof callId !== 'string') return
  try {
    if (!(await rpc.call('edit.claim', { callId }))) return
    const result = await tools.dispatch(call)
    await rpc.call('edit.report', { callId, result })
  } catch {
    // The server times the call out and tells the model; nothing to show here.
  }
}
