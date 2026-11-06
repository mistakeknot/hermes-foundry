// In-pane mock of the router, used until the Python side lands and as the "simulated" demo mode.
// Deterministic: same script, same order, no model calls, no credentials.
import { rng } from './rng'
import { recomputeWorkers } from './reducer'
import type {
  Card, Command, CommandReply, EventsReply, FoundryApi, FoundryEvent, Project, Snapshot, TranscriptReply, Worker,
} from './types'

const NATIVE_TO_STATUS: Record<string, Card['status']> = {
  triage: 'open', todo: 'open', scheduled: 'open', ready: 'open',
  running: 'running', blocked: 'blocked', review: 'review', done: 'done',
}
export function statusOf(native: string): Card['status'] { return NATIVE_TO_STATUS[native] ?? 'unknown' }

export const PROFILES = ['planner', 'coder', 'reviewer', 'ops']
const BOARDS: { id: string; name: string; epics: string[]; cards: number }[] = [
  { id: 'main', name: 'Main factory', epics: ['Ingest', 'Planner', 'Router', 'Review gate', 'Deploy'], cards: 18 },
  { id: 'docs', name: 'Docs and demos', epics: ['Guides', 'Recordings', 'Site'], cards: 12 },
  { id: 'infra', name: 'Infra', epics: ['CI', 'Hosting', 'Secrets', 'Metrics'], cards: 10 },
]
const NATIVES = ['triage', 'todo', 'ready', 'running', 'running', 'review', 'done', 'done', 'blocked', 'scheduled']
const T0 = Date.parse('2026-11-07T09:00:00Z')

export function buildFixture(scale = 1): Snapshot {
  const r = rng(20261107)
  const projects: Project[] = BOARDS.map((b) => {
    const epics = b.epics.map((t, i) => ({ id: `${b.id}:e${i + 1}`, title: t }))
    const cards: Card[] = []
    for (let i = 0; i < b.cards * scale; i++) {
      const native = NATIVES[Math.floor(r() * NATIVES.length)]
      const epic = epics[i % epics.length]
      cards.push({
        id: `${b.id}:t${i + 1}`,
        title: `${epic.title}: task ${i + 1}`,
        epic_id: i % 11 === 10 ? null : epic.id,
        status: statusOf(native),
        status_native: native,
        assignee_profile: native === 'triage' ? null : PROFILES[Math.floor(r() * PROFILES.length)],
        claimed_by: null,
        blocked_on: null,
        docs: i % 4 === 0 ? [{ path: `docs/${b.id}-${i + 1}.md`, title: `Notes ${i + 1}` }] : [],
        updated_at: new Date(T0 - Math.floor(r() * 86400e3)).toISOString(),
      })
    }
    return { id: b.id, name: b.name, epics, cards }
  })
  // 4 workers: working on running cards, one looping, one waiting on a human, one idle
  const running = projects.flatMap((p) => p.cards).filter((c) => c.status === 'running')
  const workers: Worker[] = [
    { id: 'fx:1', name: 'Ada', state: 'working', card_id: null },
    { id: 'fx:2', name: 'Bram', state: 'looping', card_id: null },
    { id: 'fx:3', name: 'Cass', state: 'waiting_human', card_id: null },
    { id: 'fx:4', name: 'Dov', state: 'idle', card_id: null },
  ]
  const give = (w: Worker, c: Card | undefined) => { if (c) { c.claimed_by = w.id; c.status = 'running'; c.status_native = 'running'; w.card_id = c.id } }
  give(workers[0], running[0])
  give(workers[1], running[1])
  const blocked = projects[0].cards.find((c) => c.status === 'open') ?? projects[0].cards[0]
  blocked.status = 'blocked'; blocked.status_native = 'blocked'; blocked.blocked_on = 'human'
  blocked.claimed_by = workers[2].id; workers[2].card_id = blocked.id
  return { v: 1, mode: 'fixture', epoch: 'fx1', cursor: 'fx1.0', last_seq: 0, projects, workers, paused: false }
}

/** Scripted storyline: each step is one event batch. */
type Step = (m: MockApi) => void

export class MockApi implements FoundryApi {
  readonly simulated = true
  private snap: Snapshot
  private log: FoundryEvent[] = []
  private seq = 0
  private epochN = 1
  private tick = 0
  private lastStep = 0
  constructor(private now: () => number = Date.now, private stepMs = 3000, private scale = 1, private logMax = 500) {
    this.snap = buildFixture(this.scale)
    this.lastStep = now()
  }

  async snapshot(): Promise<Snapshot> {
    const s = structuredClone(this.snap)
    s.last_seq = this.seq
    s.cursor = `${this.snap.epoch}.${this.seq}`
    return s
  }

  async events(cursor: string, epoch: string): Promise<EventsReply> {
    this.advance()
    const cur = `${this.snap.epoch}.${this.seq}`
    if (epoch !== this.snap.epoch) return { v: 1, epoch: this.snap.epoch, cursor: cur, events: [], resync: true }
    const since = Number(cursor.split('.').pop())
    if (!Number.isFinite(since)) return { v: 1, epoch: this.snap.epoch, cursor: cur, events: [], resync: true }
    // the oldest retained event must be the one right after `since`; otherwise the cursor has expired
    const oldest = this.log.length ? this.log[0].seq : this.seq + 1
    if (since < this.seq && oldest > since + 1) return { v: 1, epoch: this.snap.epoch, cursor: cur, events: [], resync: true }
    if (since > this.seq) return { v: 1, epoch: this.snap.epoch, cursor: cur, events: [], resync: true }
    return { v: 1, epoch: this.snap.epoch, cursor: cur, events: this.log.filter((e) => e.seq > since), resync: false }
  }

  async command(c: Command): Promise<CommandReply> {
    switch (c.type) {
      case 'set_status': {
        const card = this.card(c.card_id)
        if (!card) return { ok: false, error: `no such card ${c.card_id}` }
        const next: Card = { ...card, status_native: c.status_native, status: statusOf(c.status_native), updated_at: this.iso() }
        if (next.status !== 'blocked') next.blocked_on = null
        this.emit({ type: 'card_upsert', payload: { card: next } })
        return { ok: true }
      }
      case 'assign': {
        const card = this.card(c.card_id)
        if (!card) return { ok: false, error: `no such card ${c.card_id}` }
        if (!PROFILES.includes(c.profile)) return { ok: false, error: `unknown profile ${c.profile}` }
        this.emit({ type: 'card_upsert', payload: { card: { ...card, assignee_profile: c.profile, updated_at: this.iso() } } })
        return { ok: true } // assign does not claim: claimed_by is untouched
      }
      case 'comment': {
        if (!this.card(c.card_id)) return { ok: false, error: `no such card ${c.card_id}` }
        this.emit({ type: 'comment_added', payload: { card_id: c.card_id, author: 'you', text: c.text } })
        return { ok: true }
      }
      case 'claim': {
        const card = this.card(c.card_id)
        const w = this.snap.workers.find((x) => x.id === c.worker_id)
        if (!card || !w) return { ok: false, error: 'no such card or worker' }
        this.emit({ type: 'card_upsert', payload: { card: { ...card, claimed_by: w.id, status: 'running', status_native: 'running', updated_at: this.iso() } } })
        this.emit({ type: 'worker_upsert', payload: { worker: { ...w, state: 'working' } } })
        return { ok: true }
      }
      case 'stand':
        this.emit({ type: 'paused', payload: { paused: c.on } })
        return { ok: true }
      case 'message': {
        if (!this.snap.workers.some((x) => x.id === c.worker_id)) return { ok: false, error: `no such worker ${c.worker_id}` }
        return { ok: true } // simulated: nothing reaches a real worker
      }
      case 'new_worker':
        return { ok: false, error: 'simulated: no live launch call exists on stock Hermes' }
      case 'reset': {
        this.epochN++
        this.snap = buildFixture(this.scale)
        this.snap.epoch = `fx${this.epochN}`
        this.snap.cursor = `${this.snap.epoch}.0`
        this.log = []; this.seq = 0; this.tick = 0
        return { ok: true }
      }
    }
  }

  async transcript(workerId: string): Promise<TranscriptReply> {
    const w = this.snap.workers.find((x) => x.id === workerId)
    const lines = [
      { seq: 1, role: 'user' as const, text: `Pick up ${w?.card_id ?? 'the next card'}.` },
      { seq: 2, role: 'assistant' as const, text: 'Reading the card and its linked docs.' },
      { seq: 3, role: 'tool' as const, text: 'simulated tool output' },
    ]
    return { lines, truncated: false, next_before: null }
  }

  // --- internals ---
  private iso() { return new Date(T0 + this.seq * 1000).toISOString() }
  private card(id: string): Card | undefined {
    for (const p of this.snap.projects) { const c = p.cards.find((x) => x.id === id); if (c) return c }
  }
  /** Apply to the mock's own truth and log it. */
  private emit(e: { type: FoundryEvent['type']; payload: unknown }) {
    const ev = { seq: ++this.seq, ts: this.iso(), type: e.type, payload: e.payload } as FoundryEvent
    this.log.push(ev)
    if (this.log.length > this.logMax) this.log.splice(0, this.log.length - this.logMax)
    switch (ev.type) {
      case 'card_upsert': {
        const proj = this.snap.projects.find((p) => p.id === ev.payload.card.id.split(':')[0])!
        const i = proj.cards.findIndex((c) => c.id === ev.payload.card.id)
        if (i >= 0) proj.cards[i] = ev.payload.card; else proj.cards.push(ev.payload.card)
        break
      }
      case 'worker_upsert': {
        const i = this.snap.workers.findIndex((w) => w.id === ev.payload.worker.id)
        if (i >= 0) this.snap.workers[i] = ev.payload.worker; else this.snap.workers.push(ev.payload.worker)
        break
      }
      case 'paused': this.snap.paused = ev.payload.paused; break
      default: break
    }
    recomputeWorkers(this.snap) // the same ownership derivation the reducer uses
  }
  private advance() {
    const t = this.now()
    if (t - this.lastStep < this.stepMs) return
    this.lastStep = t
    STORY[this.tick % STORY.length](this)
    this.tick++
  }
  /** used by the story */
  story = {
    flip: (cardId: string, native: string, claimed?: string | null) => {
      const c = this.card(cardId); if (!c) return
      this.emit({ type: 'card_upsert', payload: { card: { ...c, status_native: native, status: statusOf(native), claimed_by: claimed === undefined ? c.claimed_by : claimed, blocked_on: native === 'blocked' ? c.blocked_on : null, updated_at: this.iso() } } })
    },
    worker: (id: string, state: Worker['state']) => {
      const w = this.snap.workers.find((x) => x.id === id); if (!w) return
      this.emit({ type: 'worker_upsert', payload: { worker: { ...w, state } } })
    },
    firstWhere: (pred: (c: Card) => boolean) => this.snap.projects.flatMap((p) => p.cards).find(pred),
  }
}

const STORY: Step[] = [
  (m) => { m.story.worker('fx:4', 'working'); const c = m.story.firstWhere((x) => x.status === 'open' && !x.claimed_by); if (c) m.story.flip(c.id, 'running', 'fx:4') },
  (m) => { m.story.worker('fx:2', 'working') },
  (m) => { m.story.worker('fx:2', 'looping') },
  (m) => { const c = m.story.firstWhere((x) => x.claimed_by === 'fx:1'); if (c) m.story.flip(c.id, 'review', null); m.story.worker('fx:1', 'idle') },
  (m) => { m.story.worker('fx:1', 'working'); const c = m.story.firstWhere((x) => x.status_native === 'ready' && !x.claimed_by); if (c) m.story.flip(c.id, 'running', 'fx:1') },
]
