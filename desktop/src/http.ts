// The live transport: our own router at /api/plugins/foundry, through ctx.rest (the namespace is the boundary).
import type { Command, CommandReply, EventsReply, FoundryApi, Snapshot, TranscriptReply } from './types'

export type Rest = <T>(path: string, opts?: { method?: string; body?: unknown; timeoutMs?: number }) => Promise<T>

export class HttpApi implements FoundryApi {
  readonly simulated: boolean
  constructor(private rest: Rest, simulated = false) { this.simulated = simulated }
  snapshot() { return this.rest<Snapshot>('/snapshot', { timeoutMs: 10000 }) }
  events(cursor: string, epoch: string) {
    return this.rest<EventsReply>(`/events?since=${encodeURIComponent(cursor)}&epoch=${encodeURIComponent(epoch)}`, { timeoutMs: 10000 })
  }
  async command(c: Command): Promise<CommandReply> {
    try { return await this.rest<CommandReply>('/command', { method: 'POST', body: c, timeoutMs: 10000 }) }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  }
  transcript(workerId: string, before?: number) {
    const q = `worker_id=${encodeURIComponent(workerId)}&limit=50${before != null ? `&before=${before}` : ''}`
    return this.rest<TranscriptReply>(`/transcript?${q}`, { timeoutMs: 10000 })
  }
}

/** Does the router answer? A 404 ("Plugin not found") means the Python half is not installed. */
export async function probeRouter(rest: Rest): Promise<boolean> {
  try { const s = await rest<Snapshot>('/snapshot', { timeoutMs: 4000 }); return s?.v === 1 } catch { return false }
}
