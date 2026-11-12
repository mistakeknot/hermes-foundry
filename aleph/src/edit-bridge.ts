// Server half of the agent edit bridge: a provider thread's tool call is handed to the Foundry panel,
// which owns the dispatcher, the edit history and the sidebar scope. The server never edits anything itself.

export const EDIT_CHANNEL = 'edit.call'
export type BridgeFailure = { ok: false; error: { code: 'pane_unavailable' | 'cancelled'; message: string } }
/** What the panel's dispatcher returned, kept opaque here: the bridge only relays it. */
export type PanelResult = { ok: boolean; [key: string]: unknown }
export type BridgeResult = PanelResult | BridgeFailure
interface Pending { claimed: boolean; settle: (r: BridgeResult) => void; timer: ReturnType<typeof setTimeout> }

export class EditBridge {
  private pending = new Map<string, Pending>()
  constructor(
    private publish: (channel: string, payload: unknown) => void,
    private options: { claimMs?: number; runMs?: number; newId?: () => string } = {},
  ) {}

  /** Publish one call and wait for exactly one panel to claim it and report back. */
  call(call: unknown, signal?: AbortSignal): Promise<BridgeResult> {
    const callId = (this.options.newId ?? (() => crypto.randomUUID()))()
    return new Promise<BridgeResult>(resolve => {
      const done = (r: BridgeResult) => {
        const p = this.pending.get(callId)
        if (!p) return
        clearTimeout(p.timer); this.pending.delete(callId); signal?.removeEventListener('abort', onAbort); resolve(r)
      }
      const onAbort = () => done({ ok: false, error: { code: 'cancelled', message: 'The call was cancelled' } })
      const unavailable: BridgeFailure = { ok: false, error: { code: 'pane_unavailable', message: 'The Foundry pane did not answer. Open the Foundry pane and try again.' } }
      const timer = setTimeout(() => done(unavailable), this.options.claimMs ?? 10_000)
      this.pending.set(callId, { claimed: false, settle: done, timer })
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
      this.publish(EDIT_CHANNEL, { callId, call })
    })
  }

  /** Every open panel hears the call; the first to claim it runs it. Later claims, and unknown ids, are refused. */
  claim(callId: string): boolean {
    const p = this.pending.get(callId)
    if (!p || p.claimed) return false
    p.claimed = true
    clearTimeout(p.timer)
    p.timer = setTimeout(() => p.settle({ ok: false, error: { code: 'pane_unavailable', message: 'The Foundry pane claimed the edit but did not report back. Check the pane before retrying.' } }), this.options.runMs ?? 30_000)
    return true
  }

  /** Only the claiming panel's result is accepted, once. */
  report(callId: string, result: PanelResult): boolean {
    const p = this.pending.get(callId)
    if (!p || !p.claimed) return false
    p.settle(result)
    return true
  }

  get size() { return this.pending.size }
}

/** What the model sees: the dispatcher's result without the full project state. */
export function toolText(result: BridgeResult): { text: string; isError: boolean } {
  if (!result.ok) {
    const e = (result.error ?? {}) as { code?: unknown; message?: unknown }
    return { text: `Not done (${String(e.code ?? 'error')}): ${String(e.message ?? 'unknown error')}`, isError: true }
  }
  const note = result.status === 'committed_refresh_failed' ? ' (saved, but the pane could not refresh)' : ''
  return { text: `Done: ${String(result.summary ?? 'edit applied')}${note}. Undo with edit id ${String(result.editId)}.`, isError: false }
}
