import type { AgentEditSurface } from './agent-edits'

interface Rpc {
  call(method: 'edit.claim', input: { callId: string; paneId: string }): Promise<boolean>
  call(method: 'edit.report', input: { callId: string; paneId: string; result: { ok: boolean } }): Promise<boolean>
}
/** Handle one `edit.call` broadcast: claim it (only one open pane may run it), dispatch, report. Never throws.
 *  `paneId` is this pane's random id; an undo is addressed to the pane that made the edit. */
export async function runBridgedCall(payload: unknown, tools: AgentEditSurface, rpc: Rpc, paneId: string): Promise<void> {
  if (!payload || typeof payload !== 'object') return
  const { callId, call, target } = payload as { callId?: unknown; call?: unknown; target?: unknown }
  if (typeof callId !== 'string') return
  if (target !== undefined && target !== paneId) return
  try {
    if (!(await rpc.call('edit.claim', { callId, paneId }))) return
    const result = await tools.dispatch(call)
    await rpc.call('edit.report', { callId, paneId, result })
  } catch {
    // The server times the call out and tells the model; nothing to show here.
  }
}
