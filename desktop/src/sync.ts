// Poll loop: snapshot once, then events at a fixed interval; any error or resync refetches the snapshot.
// Exactly one request is in flight at a time. resync() bumps a generation counter so a completion that
// started before it is discarded (it can never overwrite newer state), and `stopped` is checked after
// every await before any callback runs.
import { applyReply, applySnapshot } from './reducer'
import type { FoundryApi, PaneState } from './types'

export interface SyncHandle { stop(): void; resync(): void; /** poll the event stream now (after a command), without refetching the snapshot */ poll(): void }
export interface SyncOpts {
  intervalMs?: number
  onState(s: PaneState): void
  onStatus?(s: 'connecting' | 'live' | 'error', err?: string): void
}

export function startSync(api: FoundryApi, opts: SyncOpts): SyncHandle {
  const interval = opts.intervalMs ?? 2000
  let stopped = false
  let gen = 0
  let inflight = false
  let state: PaneState | null = null
  let prev: PaneState | null = null // last good state: its comments survive a snapshot refetch in the same epoch
  let kicked = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let backoff = interval

  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null } }
  const schedule = (ms: number) => { clearTimer(); if (!stopped) timer = setTimeout(() => { timer = null; void tick() }, ms) }

  const tick = async () => {
    if (stopped || inflight) return
    inflight = true
    const g = gen
    let failed = false
    try {
      if (!state) {
        const snap = await api.snapshot()
        if (stopped || g !== gen) return
        state = prev = applySnapshot(snap, prev)
        opts.onState(state)
      } else {
        const cur = state
        const rep = await api.events(cur.cursor, cur.epoch)
        if (stopped || g !== gen) return
        const r = applyReply(cur, rep)
        if (r.resync) {
          const snap = await api.snapshot()
          if (stopped || g !== gen) return
          state = prev = applySnapshot(snap, prev)
          opts.onState(state)
        } else {
          state = prev = r.state // a new cursor alone is adopted silently; only real events re-render
          if (r.state.watermark !== cur.watermark) opts.onState(state)
        }
      }
      opts.onStatus?.('live')
      backoff = interval
    } catch (e) {
      if (stopped || g !== gen) return
      failed = true
      state = null // any error: start over from a snapshot (prev keeps the comments)
      opts.onStatus?.('error', e instanceof Error ? e.message : String(e))
      backoff = Math.min(backoff * 2, 15000)
    } finally {
      inflight = false
      // a resync (or stop) that arrived mid-request: run again at once with the new generation
      if (!stopped) { const now = g !== gen || kicked; kicked = false; schedule(now ? 0 : failed ? backoff : interval) }
    }
  }
  opts.onStatus?.('connecting')
  void tick()
  return {
    stop() { stopped = true; clearTimer() },
    poll() {
      if (stopped) return
      if (inflight) { kicked = true; return }
      clearTimer(); void tick()
    },
    resync() {
      if (stopped) return
      gen++
      state = null
      if (!inflight) { clearTimer(); void tick() }
    },
  }
}
