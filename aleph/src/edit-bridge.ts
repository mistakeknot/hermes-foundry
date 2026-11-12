// Server half of the agent edit bridge: a provider thread's tool call is handed to the Foundry panel,
// which owns the dispatcher, the edit history and the sidebar scope. The server never edits anything itself.

export const EDIT_CHANNEL = 'edit.call'
export interface BridgeFailure { ok: false; error: { code: 'pane_unavailable' | 'cancelled' | 'not_found' | 'outcome_unknown'; message: string } }
/** What the panel's dispatcher returned, kept opaque here: the bridge only relays it. */
export type PanelResult = { ok: boolean; [key: string]: unknown }
export type BridgeResult = PanelResult | BridgeFailure
export interface BridgeCall { name: string; arguments: Record<string, unknown> }
interface Pending { claimedBy?: string; target?: string; settle: (r: BridgeResult) => void; timer: ReturnType<typeof setTimeout> }

const UNKNOWN = 'The Foundry pane started this edit but the result is not confirmed, so it may have been applied. Check the pane before retrying.'
const MAX_HANDLES = 500

export class EditBridge {
  private pending = new Map<string, Pending>()
  // Each pane numbers its own edits from 1, so the model is given bridge-wide handles instead, and an undo goes
  // only to the pane that made the edit.
  private handles = new Map<number, { paneId: string; localId: number }>()
  private nextHandle = 1
  constructor(
    private publish: (channel: string, payload: unknown) => void,
    private options: { claimMs?: number; runMs?: number; newId?: () => string } = {},
  ) {}

  /** Publish one call and wait for exactly one panel to claim it and report back. */
  call(call: BridgeCall, signal?: AbortSignal): Promise<BridgeResult> {
    let target: string | undefined
    let sent: BridgeCall = call
    if (call.name === 'undo_edit') {
      const owner = this.handles.get(call.arguments.editId as number)
      if (!owner) return Promise.resolve({ ok: false, error: { code: 'not_found', message: 'No edit with that id was made in this session.' } })
      target = owner.paneId
      sent = { ...call, arguments: { ...call.arguments, editId: owner.localId } }
    }
    const callId = (this.options.newId ?? (() => crypto.randomUUID()))()
    return new Promise<BridgeResult>(resolve => {
      const done = (r: BridgeResult) => {
        const p = this.pending.get(callId)
        if (!p) return
        clearTimeout(p.timer); this.pending.delete(callId); signal?.removeEventListener('abort', onAbort); resolve(r)
      }
      const onAbort = () => done(this.pending.get(callId)?.claimedBy
        ? { ok: false, error: { code: 'outcome_unknown', message: `The call was cancelled after the pane started it. ${UNKNOWN}` } }
        : { ok: false, error: { code: 'cancelled', message: 'The call was cancelled' } })
      const unavailable: BridgeFailure = { ok: false, error: { code: 'pane_unavailable', message: 'The Foundry pane did not answer. Open the Foundry pane and try again.' } }
      const timer = setTimeout(() => done(unavailable), this.options.claimMs ?? 10_000)
      this.pending.set(callId, { target, settle: done, timer })
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
      this.publish(EDIT_CHANNEL, target ? { callId, call: sent, target } : { callId, call: sent })
    })
  }

  /** Every open panel hears the call; the first to claim it runs it. Later claims, unknown ids and (for an undo) other panes are refused. */
  claim(callId: string, paneId: string): boolean {
    const p = this.pending.get(callId)
    if (!p || p.claimedBy || (p.target && p.target !== paneId)) return false
    p.claimedBy = paneId
    clearTimeout(p.timer)
    p.timer = setTimeout(() => p.settle({ ok: false, error: { code: 'outcome_unknown', message: `The pane did not report back in time. ${UNKNOWN}` } }), this.options.runMs ?? 30_000)
    return true
  }

  /** Only the claiming panel's result is accepted, once. A numeric edit id in it is swapped for a bridge-wide handle. */
  report(callId: string, paneId: string, result: PanelResult): boolean {
    const p = this.pending.get(callId)
    if (!p || p.claimedBy !== paneId) return false
    p.settle(typeof result.editId === 'number' ? { ...result, editId: this.handle(paneId, result.editId) } : result)
    return true
  }

  private handle(paneId: string, localId: number): number {
    const id = this.nextHandle++
    this.handles.set(id, { paneId, localId })
    if (this.handles.size > MAX_HANDLES) this.handles.delete(this.handles.keys().next().value as number)
    return id
  }

  get size() { return this.pending.size }
}

/** What the model sees: the dispatcher's result without the full project state. */
export function toolText(result: BridgeResult, name?: string): { text: string; isError: boolean } {
  if (!result.ok) {
    const e = (result.error ?? {}) as { code?: unknown; message?: unknown }
    const unknown = e.code === 'outcome_unknown'
    return { text: `${unknown ? 'Not confirmed' : 'Not done'} (${String(e.code ?? 'error')}): ${String(e.message ?? 'unknown error')}`, isError: true }
  }
  const note = result.status === 'committed_refresh_failed' ? ' (saved, but the pane could not refresh)' : ''
  const base = `Done: ${String(result.summary ?? 'edit applied')}${note}`
  // An undo's own entry has no inverse, so offering its id would only lead to a not_found.
  if (name === 'undo_edit') return { text: `${base}.`, isError: false }
  return { text: `${base}. Undo with edit id ${String(result.editId)}.`, isError: false }
}
