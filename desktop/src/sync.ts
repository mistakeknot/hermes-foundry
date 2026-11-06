// Poll loop: snapshot once, then events at a fixed interval; any error or resync refetches the snapshot.
import { applyReply, applySnapshot } from './reducer'
import type { FoundryApi, PaneState } from './types'

export interface SyncHandle { stop(): void; resync(): void }
export interface SyncOpts {
  intervalMs?: number
  onState(s: PaneState): void
  onStatus?(s: 'connecting' | 'live' | 'error', err?: string): void
}

export function startSync(api: FoundryApi, opts: SyncOpts): SyncHandle {
  const interval = opts.intervalMs ?? 2000
  let stopped = false
  let state: PaneState | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let backoff = interval

  const fetchSnapshot = async () => {
    state = applySnapshot(await api.snapshot())
    opts.onState(state)
  }
  const loop = async () => {
    if (stopped) return
    try {
      if (!state) await fetchSnapshot()
      else {
        const rep = await api.events(state.cursor, state.epoch)
        const r = applyReply(state, rep)
        if (r.resync) await fetchSnapshot()
        else if (r.state !== state) { state = r.state; opts.onState(state) }
        else if (r.state.cursor !== state.cursor) state = r.state
      }
      opts.onStatus?.('live')
      backoff = interval
    } catch (e) {
      state = null // any error: start over from a snapshot
      opts.onStatus?.('error', e instanceof Error ? e.message : String(e))
      backoff = Math.min(backoff * 2, 15000)
    }
    if (!stopped) timer = setTimeout(loop, backoff)
  }
  opts.onStatus?.('connecting')
  void loop()
  return {
    stop() { stopped = true; if (timer) clearTimeout(timer) },
    resync() { state = null; if (timer) clearTimeout(timer); void loop() },
  }
}
