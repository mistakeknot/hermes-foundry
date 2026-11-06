// Contract draft 3 (docs/contract.md on work/plan-review). Types only.
export type CardStatus = 'open' | 'running' | 'blocked' | 'review' | 'done' | 'unknown'
export type WorkerState = 'working' | 'waiting_human' | 'looping' | 'idle' | 'unknown'

export interface Doc { path: string; title: string }
export interface Epic { id: string; title: string }
export interface Card {
  id: string
  title: string
  epic_id: string | null
  status: CardStatus
  status_native: string
  assignee_profile: string | null
  claimed_by: string | null
  blocked_on: 'human' | null
  docs: Doc[]
  updated_at: string
}
export interface Project { id: string; name: string; epics: Epic[]; cards: Card[] }
export interface Worker { id: string; name: string; state: WorkerState; card_id: string | null }

export interface Snapshot {
  v: 1
  mode: 'fixture' | 'live'
  epoch: string
  cursor: string
  last_seq: number
  projects: Project[]
  workers: Worker[]
  paused: boolean
}

export type FoundryEvent =
  | { seq: number; ts: string; type: 'card_upsert'; payload: { card: Card } }
  | { seq: number; ts: string; type: 'card_removed'; payload: { card_id: string } }
  | { seq: number; ts: string; type: 'comment_added'; payload: { card_id: string; author: string; text: string } }
  | { seq: number; ts: string; type: 'worker_upsert'; payload: { worker: Worker } }
  | { seq: number; ts: string; type: 'worker_removed'; payload: { worker_id: string } }
  | { seq: number; ts: string; type: 'paused'; payload: { paused: boolean } }

export interface EventsReply {
  v: 1
  epoch: string
  cursor: string
  events: FoundryEvent[]
  resync: boolean
}

export type Command =
  | { type: 'set_status'; card_id: string; status_native: string }
  | { type: 'assign'; card_id: string; profile: string }
  | { type: 'comment'; card_id: string; text: string }
  | { type: 'claim'; card_id: string; worker_id: string }
  | { type: 'new_worker'; card_id: string }
  | { type: 'reset' }
export type CommandReply = { ok: boolean; error?: string }

export interface TranscriptReply {
  lines: { seq: number; role: 'user' | 'assistant' | 'tool'; text: string }[]
  truncated: boolean
  next_before: number | null
}

/** The only thing the pane talks to. The transport behind it does not matter. */
export interface FoundryApi {
  /** true when the data is not from a live Hermes (drives the "simulated" badge). */
  readonly simulated: boolean
  snapshot(): Promise<Snapshot>
  events(cursor: string, epoch: string): Promise<EventsReply>
  command(c: Command): Promise<CommandReply>
  transcript?(workerId: string, before?: number): Promise<TranscriptReply>
}

/** Pane state: the snapshot plus the sync watermark. */
export interface PaneState {
  snap: Snapshot
  watermark: number
  cursor: string
  epoch: string
  comments: { card_id: string; author: string; text: string; seq: number }[]
}
