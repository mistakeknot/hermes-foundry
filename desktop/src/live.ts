// Host-neutral live source: turns a plain list of "projects, sections, threads" (any host that has them) into the
// Foundry contract (snapshot + event stream), read-only. projects -> boards, sections -> epics, threads -> cards,
// running threads -> climbers on their own card. No I/O and no clock of its own (the caller passes `now`), so it is
// unit-testable and shared by every host adapter. Not imported by src/plugin.ts: the Hermes bundle does not carry it.
import type { Card, Command, CommandReply, EventsReply, FoundryApi, FoundryEvent, Project, Snapshot, Worker } from './types'
import type { Rest } from './http'

export interface LiveProject { id: string; name: string }
export interface LiveSection { id: string; name: string }
export interface LiveThread {
  id: string
  projectId: string
  title: string
  sectionId: string | null
  /** the agent/provider that runs the thread; shown as the card's profile */
  provider: string | null
  /** the host's execution status: active/starting/pending = working, error, idle, stopping */
  status: string
  /** the thread is waiting for a person (a question, an approval) */
  needsHuman: boolean
  /** finished work nobody has looked at yet */
  unread: boolean
  archived: boolean
  hidden: boolean
  /** epoch milliseconds */
  updatedAt: number
}
export interface LiveInput { projects: LiveProject[]; sections: LiveSection[]; threads: LiveThread[]; now: number }

export interface LiveOptions {
  /** most cards drawn in all; working and waiting threads are taken first (default 240) */
  maxCards?: number
  /** an idle thread untouched this long is shown as done (default 24h) */
  doneAfterMs?: number
}

const WORKING = new Set(['active', 'starting', 'pending'])

export const READ_ONLY_ERROR = 'Foundry is read-only here: it shows threads but does not act on them yet'

/** A thread has no "done" of its own, so this is a reading, not a fact: see mapStatus. */
export function mapStatus(t: LiveThread, now: number, doneAfterMs: number): { status: Card['status']; native: string; blockedOn: 'human' | null } {
  if (t.needsHuman) return { status: 'blocked', native: 'blocked', blockedOn: 'human' }
  if (t.status === 'error') return { status: 'blocked', native: 'error', blockedOn: null }
  if (WORKING.has(t.status)) return { status: 'running', native: 'running', blockedOn: null }
  if (t.status === 'stopping') return { status: 'running', native: 'stopping', blockedOn: null }
  if (t.unread) return { status: 'review', native: 'review', blockedOn: null }
  if (now - t.updatedAt > doneAfterMs) return { status: 'done', native: 'done', blockedOn: null }
  return { status: 'open', native: 'ready', blockedOn: null }
}

const cardId = (projectId: string, threadId: string) => `${projectId}:${threadId}`
const iso = (ms: number) => new Date(Number.isFinite(ms) ? ms : 0).toISOString()

export type LiveShape = Omit<Snapshot, 'epoch' | 'cursor' | 'last_seq'>

/** Pure: the board the pane should draw for this input. */
export function buildLiveShape(input: LiveInput, opts: LiveOptions = {}): LiveShape {
  const maxCards = opts.maxCards ?? 240
  const doneAfterMs = opts.doneAfterMs ?? 24 * 3600_000
  const known = new Set(input.projects.map((p) => p.id))
  const sectionIds = new Set(input.sections.map((s) => s.id))
  const rank = (t: LiveThread) => (t.needsHuman ? 0 : WORKING.has(t.status) || t.status === 'stopping' ? 1 : t.status === 'error' ? 2 : 3)
  const kept = input.threads
    .filter((t) => !t.archived && !t.hidden && known.has(t.projectId))
    .sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1))
    .slice(0, maxCards)

  const byProject = new Map<string, Card[]>()
  const workers: Worker[] = []
  const usedEpics = new Map<string, Set<string>>()
  for (const t of kept) {
    const m = mapStatus(t, input.now, doneAfterMs)
    const id = cardId(t.projectId, t.id)
    const working = WORKING.has(t.status) || t.status === 'stopping'
    const epic = t.sectionId && sectionIds.has(t.sectionId) ? t.sectionId : null
    const card: Card = {
      id, title: t.title || t.id, epic_id: epic, status: m.status, status_native: m.native,
      assignee_profile: t.provider, claimed_by: working || t.needsHuman ? t.id : null, blocked_on: m.blockedOn, docs: [], updated_at: iso(t.updatedAt),
    }
    ;(byProject.get(t.projectId) ?? byProject.set(t.projectId, []).get(t.projectId)!).push(card)
    if (epic) (usedEpics.get(t.projectId) ?? usedEpics.set(t.projectId, new Set()).get(t.projectId)!).add(epic)
    if (card.claimed_by) workers.push({ id: t.id, name: card.title, state: t.needsHuman ? 'waiting_human' : 'working', card_id: id })
  }
  const projects: Project[] = input.projects
    .filter((p) => byProject.has(p.id))
    .map((p) => ({
      id: p.id, name: p.name,
      epics: input.sections.filter((s) => usedEpics.get(p.id)?.has(s.id)).map((s) => ({ id: s.id, title: s.name })),
      cards: byProject.get(p.id)!.sort((a, b) => (a.id < b.id ? -1 : 1)),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
  workers.sort((a, b) => (a.id < b.id ? -1 : 1))
  return { v: 1, mode: 'live', read_only: true, projects, workers, paused: false }
}

const MAX_LOG = 1000

/**
 * A FoundryApi over a changing input. `update()` diffs each new shape against the last and appends contract events;
 * a change events cannot express (a project or epic appearing or going) bumps the epoch, so the pane resyncs.
 */
export class LiveApi implements FoundryApi {
  readonly simulated = false
  private shape: LiveShape = { v: 1, mode: 'live', read_only: true, projects: [], workers: [], paused: false }
  private seq = 0
  private base = 0 // log holds events with seq > base
  private log: FoundryEvent[] = []
  private epochN = 0
  private ready = false
  constructor(private opts: LiveOptions = {}, private clock: () => number = Date.now, private tag = Math.random().toString(36).slice(2, 8)) {}

  get epoch() { return `${this.tag}-${this.epochN}` }
  get lastSeq() { return this.seq }

  update(input: LiveInput): void {
    const next = buildLiveShape(input, this.opts)
    if (!this.ready) { this.shape = next; this.ready = true; return }
    const prev = this.shape
    const structure = (s: LiveShape) => JSON.stringify(s.projects.map((p) => [p.id, p.name, p.epics]))
    if (structure(prev) !== structure(next)) {
      this.epochN++; this.seq = 0; this.base = 0; this.log = []; this.shape = next; return
    }
    const ts = iso(this.clock())
    const push = (type: FoundryEvent['type'], payload: unknown) => { this.log.push({ seq: ++this.seq, ts, type, payload } as FoundryEvent) }
    const was = new Map(prev.projects.flatMap((p) => p.cards).map((c) => [c.id, JSON.stringify(c)]))
    const now = new Map(next.projects.flatMap((p) => p.cards).map((c) => [c.id, c]))
    for (const [id, c] of now) if (was.get(id) !== JSON.stringify(c)) push('card_upsert', { card: c })
    for (const id of was.keys()) if (!now.has(id)) push('card_removed', { card_id: id })
    const wasW = new Map(prev.workers.map((w) => [w.id, JSON.stringify({ ...w, card_id: null })]))
    const nowW = new Map(next.workers.map((w) => [w.id, w]))
    for (const [id, w] of nowW) if (wasW.get(id) !== JSON.stringify({ ...w, card_id: null })) push('worker_upsert', { worker: w })
    for (const id of wasW.keys()) if (!nowW.has(id)) push('worker_removed', { worker_id: id })
    if (this.log.length > MAX_LOG) { const drop = this.log.length - MAX_LOG; this.base = this.log[drop - 1].seq; this.log = this.log.slice(drop) }
    this.shape = next
  }

  async snapshot(): Promise<Snapshot> {
    if (!this.ready) throw new Error('live source has no data yet')
    return structuredClone({ ...this.shape, epoch: this.epoch, cursor: String(this.seq), last_seq: this.seq })
  }

  async events(cursor: string, epoch: string): Promise<EventsReply> {
    const since = Number(cursor)
    const stale = epoch !== this.epoch || !Number.isInteger(since) || since < this.base || since > this.seq
    if (stale) return { v: 1, epoch: this.epoch, cursor: String(this.seq), events: [], resync: true }
    return { v: 1, epoch: this.epoch, cursor: String(this.seq), events: structuredClone(this.log.filter((e) => e.seq > since)), resync: false }
  }

  async command(_c: Command): Promise<CommandReply> { return { ok: false, error: READ_ONLY_ERROR } }
}

/**
 * The pane speaks the contract over a `Rest` transport (path -> JSON). This serves that transport from a FoundryApi in
 * the same process, so a host with no HTTP router can still drive the unchanged pane. Unknown paths reject like a 404.
 */
export function restFromApi(get: () => FoundryApi | null): Rest {
  return async <T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> => {
    const api = get()
    if (!api) throw new Error('404: no live source')
    const u = new URL(path, 'http://local')
    const post = (opts?.method ?? 'GET').toUpperCase() === 'POST'
    if (!post && u.pathname === '/snapshot') return (await api.snapshot()) as T
    if (!post && u.pathname === '/events') return (await api.events(u.searchParams.get('since') ?? '', u.searchParams.get('epoch') ?? '')) as T
    if (post && u.pathname === '/command') return (await api.command(opts?.body as Command)) as T
    throw new Error(`404: ${u.pathname}`)
  }
}
