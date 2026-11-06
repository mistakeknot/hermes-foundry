// Foundry desktop pane: /foundry route + sidebar row. Plain-ESM bundle for Hermes; no JSX syntax.
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ROUTES_AREA, SIDEBAR_NAV_AREA } from '@hermes/plugin-sdk'
import { FoundryScene, STATUS_COLOR, WORKER_COLOR, type Pick } from './scene'
import { loadUnlessCancelled } from './stale'
import { HttpApi, probeRouter, type Rest } from './http'
import { MockApi, PROFILES } from './mock'
import { startSync, type SyncHandle } from './sync'
import { findCard } from './reducer'
import { knownStatus } from './status-look'
import { dropUi, type AssignRequest } from './drag'
import type { Card, Command, FoundryApi, PaneState, TranscriptReply, Worker } from './types'

type Child = unknown
const h = (type: unknown, props: Record<string, unknown> | null, ...kids: Child[]) =>
  kids.length ? jsxs(type, { ...props, children: kids.flat() }) : jsx(type, props ?? {})

const V = (name: string, fb: string) => `var(--dt-${name}, ${fb})`
const C = {
  fg: V('foreground', '#e9eadf'), bg: V('background', '#1a201d'), card: V('card', '#232b27'), border: V('border', '#3a443e'),
  muted: V('muted-foreground', '#9aa59c'), primary: V('primary', '#e6a93c'), danger: V('destructive', '#c2483a'),
}
const mono = V('font-mono', 'ui-monospace, monospace')
const sans = V('font-sans', 'system-ui, sans-serif')
const ON_DARK = '#eef2e6'
const ON_DARK_MUTED = '#b8c2b6'
const hex = (n: number) => '#' + n.toString(16).padStart(6, '0')
const NATIVE_CHOICES = ['todo', 'ready', 'running', 'blocked', 'review', 'done']

const btn = (primary = false): Record<string, unknown> => ({
  font: `12px ${sans}`, padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
  border: `1px solid ${primary ? C.primary : C.border}`, background: primary ? C.primary : 'transparent', color: primary ? '#1a1a14' : C.fg,
})
const field: Record<string, unknown> = { font: `12px ${sans}`, padding: '5px 8px', borderRadius: 6, border: `1px solid ${C.border}`, background: C.bg, color: C.fg, minWidth: 0 }
const chip = (color: string): Record<string, unknown> => ({ display: 'inline-block', padding: '1px 8px', borderRadius: 10, background: color, color: '#16160f', font: `600 11px ${sans}` })
const sect = (t: string) => h('div', { style: { font: `600 10px ${sans}`, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.muted, margin: '14px 0 6px' } }, t)

/** `?foundryScale=N` multiplies the fixture's card count, to exercise the crowded-valley view. */
function fixtureScale(): number {
  const n = Number(new URLSearchParams(globalThis.location?.search ?? '').get('foundryScale'))
  return Number.isFinite(n) && n >= 1 && n <= 20 ? Math.floor(n) : 1
}

export function pickApi(rest: Rest): Promise<FoundryApi> {
  return probeRouter(rest).then((ok) => (ok ? new HttpApi(rest, false) : new MockApi(Date.now, 3000, fixtureScale())))
}

function FoundryPage({ rest }: { rest: Rest }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const labelsRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<FoundryScene | null>(null)
  const syncRef = useRef<SyncHandle | null>(null)
  const [api, setApi] = useState<FoundryApi | null>(null)
  const [state, setState] = useState<PaneState | null>(null)
  const [link, setLink] = useState<string>('connecting')
  const [pick, setPick] = useState<Pick | null>(null)
  const [tip, setTip] = useState<{ label: string; x: number; y: number } | null>(null)
  const [notice, setNotice] = useState<{ text: string; err: boolean; sim: boolean } | null>(null)
  const [webgl, setWebgl] = useState(true)
  // set by dropping a climber on a scale: opens that card's profile selector. Carries no profile and no command.
  const [assignReq, setAssignReq] = useState<AssignRequest | null>(null)
  const snapRef = useRef<PaneState['snap'] | null>(null)

  // pick the source once: our router if it answers, otherwise the in-pane fixture
  useEffect(() => { let off = false; pickApi(rest).then((a) => { if (!off) setApi(a) }); return () => { off = true } }, [])

  useEffect(() => {
    if (!api) return
    const s = startSync(api, { intervalMs: api.simulated ? 1000 : 2000, onState: setState, onStatus: (st) => setLink(st) })
    syncRef.current = s
    return () => s.stop()
  }, [api])

  // three.js scene lifecycle + container tracking
  useEffect(() => {
    const canvas = canvasRef.current, host = hostRef.current, labels = labelsRef.current
    if (!canvas || !host || !labels) return
    let scene: FoundryScene
    try {
      scene = new FoundryScene(canvas, labels, {
        onPick: (p) => setPick(p),
        onHover: (label, x, y) => {
          const r = host.getBoundingClientRect()
          setTip(label ? { label, x: x - r.left + 12, y: y - r.top + 12 } : null)
        },
        onDrop: (req) => {
          const sn = snapRef.current
          const ui = sn ? dropUi(req, sn) : null
          if (!ui) return
          setTip(null)
          setPick(ui.pick)
          setAssignReq(ui.request)
          setNotice({ text: ui.notice, err: false, sim: false })
        },
      })
    } catch { setWebgl(false); return }
    sceneRef.current = scene
    ;(globalThis as any).__foundry = { scene }
    const fit = () => scene.resize(host.clientWidth, host.clientHeight)
    const ro = new ResizeObserver(fit)
    ro.observe(host)
    fit()
    return () => { ro.disconnect(); scene.dispose(); sceneRef.current = null; delete (globalThis as any).__foundry }
  }, [])

  const snap = state?.snap ?? null
  snapRef.current = snap
  useEffect(() => { if (snap) sceneRef.current?.update(snap) }, [snap])
  useEffect(() => {
    const s = sceneRef.current
    if (!s) return
    s.select(pick?.kind === 'card' ? pick.id : pick?.kind === 'doc' ? pick.cardId : null)
  }, [pick, snap])

  const simulated = !!api?.simulated || snap?.mode === 'fixture'

  const run = async (c: Command, okText: string): Promise<boolean> => {
    if (!api) return false
    let r: { ok: boolean; error?: string }
    try { r = await api.command(c) } catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e) } }
    // a failed command changes no state: show the error, do not touch the display
    setNotice({ text: r.ok ? okText : r.error ?? 'command failed', err: !r.ok, sim: simulated })
    if (r.ok) syncRef.current?.poll() // the upsert / comment_added events arrive on the next poll
    return r.ok
  }

  const counts = useMemo(() => {
    const n: Record<string, number> = { open: 0, running: 0, blocked: 0, review: 0, done: 0, unknown: 0 }
    snap?.projects.forEach((p) => p.cards.forEach((c) => { n[knownStatus(c.status)]++ }))
    return n
  }, [snap])

  const header = h('div', { style: { position: 'absolute', top: 10, left: 12, right: 12, display: 'flex', gap: 10, alignItems: 'center', pointerEvents: 'none', flexWrap: 'wrap' } },
    h('div', { style: { font: `600 14px ${sans}`, color: ON_DARK, textShadow: '0 1px 3px #000' } }, 'Foundry'),
    simulated ? h('span', { id: 'foundry-simulated', style: { ...chip('#e6a93c'), pointerEvents: 'auto' }, title: 'Showing fixture data; actions do not reach a live Hermes board' }, 'simulated') : null,
    snap?.paused ? h('span', { style: chip('#6fd3ff') }, 'standing') : null,
    link === 'error' ? h('span', { style: chip(hex(STATUS_COLOR.blocked)) }, 'reconnecting') : null,
    h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 10, font: `11px ${sans}`, color: ON_DARK_MUTED, textShadow: '0 1px 3px #000' } },
      (['open', 'running', 'blocked', 'review', 'done'] as const).map((k) => h('span', { key: k, style: { display: 'inline-flex', gap: 4, alignItems: 'center' } },
        h('i', { style: { width: 9, height: 9, borderRadius: 2, background: hex(STATUS_COLOR[k]), display: 'inline-block' } }), `${k} ${counts[k]}`)),
      counts.unknown ? h('span', { style: { display: 'inline-flex', gap: 4, alignItems: 'center' } }, h('i', { style: { width: 9, height: 9, borderRadius: 2, background: hex(STATUS_COLOR.unknown), display: 'inline-block' } }), `other ${counts.unknown}`) : null))

  const stage = h('div', { ref: hostRef, style: { position: 'relative', flex: 1, minWidth: 0, background: '#1d2622', overflow: 'hidden' } },
    h('canvas', { ref: canvasRef, style: { position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', cursor: 'grab' } }),
    h('div', { ref: labelsRef, style: { position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' } }),
    header,
    tip ? h('div', { style: { position: 'absolute', left: tip.x, top: tip.y, background: C.card, color: C.fg, border: `1px solid ${C.border}`, borderRadius: 6, padding: '3px 8px', font: `11px ${sans}`, pointerEvents: 'none', maxWidth: 280 } }, tip.label) : null,
    !webgl ? h('div', { style: { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: ON_DARK_MUTED, font: `13px ${sans}` } }, 'WebGL is not available in this window.') : null,
    !snap && webgl ? h('div', { style: { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: ON_DARK_MUTED, font: `13px ${sans}`, pointerEvents: 'none' } }, 'Waking the valley…') : null,
    h('div', { style: { position: 'absolute', left: 12, bottom: 10, font: `11px ${sans}`, color: ON_DARK_MUTED, textShadow: '0 1px 3px #000', pointerEvents: 'none' } }, 'drag to orbit · scroll to zoom · click a scale, carving or climber · double-click a creature to approach'))

  const panel = h('div', { id: 'foundry-panel', style: { width: 330, flex: 'none', borderLeft: `1px solid ${C.border}`, background: C.card, color: C.fg, font: `13px ${sans}`, overflowY: 'auto', padding: '12px 14px' } },
    snap ? Panel({ snap, state: state!, pick, setPick, run, notice, simulated, api: api!, scene: sceneRef, assignReq, clearAssignReq: () => setAssignReq(null) }) : null)

  return h('div', { style: { display: 'flex', height: '100%', width: '100%', background: C.bg } }, stage, panel)
}

interface PanelProps {
  snap: NonNullable<PaneState['snap']>; state: PaneState; pick: Pick | null; setPick(p: Pick | null): void
  run(c: Command, ok: string): Promise<boolean>; notice: { text: string; err: boolean; sim: boolean } | null
  simulated: boolean; api: FoundryApi; scene: { current: FoundryScene | null }
  assignReq: AssignRequest | null; clearAssignReq(): void
}

function Panel(p: PanelProps) {
  return h(PanelBody, p as unknown as Record<string, unknown>)
}

function PanelBody(p: PanelProps) {
  const { snap, pick, setPick } = p
  const card = pick?.kind === 'card' ? findCard(snap, pick.id) : pick?.kind === 'doc' ? findCard(snap, pick.cardId) : undefined
  const noticeEl = p.notice ? h('div', { id: 'foundry-notice', style: { marginTop: 10, padding: '6px 8px', borderRadius: 6, font: `12px ${sans}`, border: `1px solid ${p.notice.err ? C.danger : C.border}`, color: p.notice.err ? '#ffb4a8' : C.fg } },
    p.notice.text, p.notice.sim ? h('span', { style: { ...chip('#e6a93c'), marginLeft: 8 } }, 'simulated') : null) : null
  if (pick?.kind === 'card' && card) return h('div', null, CardView({ ...p, card }), noticeEl)
  if (pick?.kind === 'doc' && card) return h('div', null, DocView({ ...p, card, doc: pick }), noticeEl)
  if (pick?.kind === 'worker') {
    const w = snap.workers.find((x) => x.id === pick.id)
    if (w) return h('div', null, h(WorkerView, { ...p, worker: w } as unknown as Record<string, unknown>), noticeEl)
  }
  if (pick?.kind === 'project') {
    const pr = snap.projects.find((x) => x.id === pick.id)
    if (pr) return h('div', null, backLink(setPick), h('div', { style: { font: `600 16px ${sans}` } }, pr.name), h('div', { style: { color: C.muted, marginTop: 2 } }, `${pr.cards.length} cards · ${pr.epics.length} epics`),
      h('button', { style: { ...btn(), marginTop: 10 }, onClick: () => p.scene.current?.focusCreature(pr.id) }, 'Approach'), sect('Epics'), ...pr.epics.map((e) => h('div', { key: e.id, style: { padding: '2px 0' } }, `${e.title} · ${pr.cards.filter((c) => c.epic_id === e.id).length}`)))
  }
  return h('div', null, Overview(p), noticeEl)
}

const backLink = (setPick: (p: Pick | null) => void) => h('button', { style: { ...btn(), marginBottom: 10 }, onClick: () => setPick(null) }, '← Overview')

function Overview(p: PanelProps) {
  const { snap, setPick } = p
  return h('div', null,
    h('div', { style: { font: `600 16px ${sans}` } }, 'The valley'),
    h('div', { style: { color: C.muted, marginTop: 2 } }, `${snap.projects.length} creatures · ${snap.projects.reduce((n, x) => n + x.cards.length, 0)} cards · ${snap.workers.length} climbers`),
    sect('Creatures'),
    ...snap.projects.map((pr) => h('div', { key: pr.id, style: { padding: '4px 0', cursor: 'pointer' }, onClick: () => { setPick({ kind: 'project', id: pr.id }); p.scene.current?.focusCreature(pr.id) } },
      h('b', null, pr.name), h('span', { style: { color: C.muted } }, ` · ${pr.cards.length} cards`))),
    sect('Climbers'),
    ...snap.workers.map((w) => h('div', { key: w.id, style: { padding: '4px 0', cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'center' }, onClick: () => setPick({ kind: 'worker', id: w.id }) },
      h('i', { style: { width: 10, height: 10, borderRadius: 5, background: hex(WORKER_COLOR[w.state]), display: 'inline-block' } }), h('span', null, w.name), h('span', { style: { color: C.muted } }, ` ${w.state}`))))
}

function CardView(p: PanelProps & { card: Card }) {
  const { card, snap } = p
  const holder = card.claimed_by ? snap.workers.find((w) => w.id === card.claimed_by) : null
  return h(CardActions, { ...p, holderName: holder?.name ?? null } as unknown as Record<string, unknown>)
}

function CardActions(p: PanelProps & { card: Card; holderName: string | null }) {
  const { card, snap, setPick } = p
  const [status, setStatus] = useState(card.status_native)
  const [profile, setProfile] = useState(card.assignee_profile ?? '')
  const [text, setText] = useState('')
  const profileRef = useRef<HTMLInputElement>(null)
  // a climber dropped on this card: focus the same profile field the Assign button uses, then forget the request
  useEffect(() => {
    const r = p.assignReq
    if (!r || r.cardId !== card.id) return
    profileRef.current?.focus()
    p.clearAssignReq()
  }, [p.assignReq, card.id])
  useEffect(() => { setStatus(card.status_native); setProfile(card.assignee_profile ?? '') }, [card.id, card.status_native, card.assignee_profile])
  const profiles = useMemo(() => {
    const s = new Set<string>(p.simulated ? PROFILES : [])
    snap.projects.forEach((x) => x.cards.forEach((c) => { if (c.assignee_profile) s.add(c.assignee_profile) }))
    return [...s].sort()
  }, [snap, p.simulated])
  const comments = p.state.comments.filter((c) => c.card_id === card.id)
  const choices = NATIVE_CHOICES.includes(card.status_native) ? NATIVE_CHOICES : [card.status_native, ...NATIVE_CHOICES]
  const row = { display: 'flex', gap: 6, marginTop: 6 }
  return h('div', null,
    backLink(setPick),
    h('div', { style: { font: `600 15px ${sans}`, lineHeight: 1.25 } }, card.title),
    h('div', { style: { color: C.muted, fontFamily: mono, fontSize: 11, marginTop: 2 } }, card.id),
    h('div', { style: { marginTop: 8, display: 'flex', gap: 6, alignItems: 'center' } },
      h('span', { style: chip(hex(STATUS_COLOR[knownStatus(card.status)])) }, knownStatus(card.status) === 'unknown' ? `unknown · ${card.status_native}` : card.status_native),
      card.blocked_on === 'human' ? h('span', { id: 'foundry-blocked-human', style: chip('#6fd3ff') }, 'waiting on you') : null),
    h('div', { style: { color: C.muted, marginTop: 8 } }, 'Profile: ', h('span', { style: { color: C.fg } }, card.assignee_profile ?? 'unassigned')),
    h('div', { style: { color: C.muted } }, 'Held by: ', h('span', { style: { color: C.fg } }, p.holderName ?? (card.claimed_by ? `${card.claimed_by} (unknown worker)` : 'nobody'))),
    card.docs.length ? sect('Carvings') : null,
    ...card.docs.map((d) => h('div', { key: d.path, style: { padding: '2px 0', cursor: 'pointer', color: C.primary }, onClick: () => setPick({ kind: 'doc', cardId: card.id, path: d.path, title: d.title }) }, `▫ ${d.title}`)),
    sect('Move'),
    h('div', { style: row },
      h('select', { id: 'foundry-status', style: { ...field, flex: 1 }, value: status, onChange: (e: any) => setStatus(e.target.value) }, ...choices.map((n) => h('option', { key: n, value: n }, n))),
      h('button', { id: 'foundry-status-apply', style: btn(true), disabled: status === card.status_native, onClick: () => p.run({ type: 'set_status', card_id: card.id, status_native: status }, `Moved to ${status}`) }, 'Set status')),
    sect('Assign profile'),
    h('div', { style: row },
      h('input', { id: 'foundry-profile', ref: profileRef, list: 'foundry-profiles', style: { ...field, flex: 1 }, value: profile, placeholder: 'profile', onChange: (e: any) => setProfile(e.target.value) }),
      h('datalist', { id: 'foundry-profiles' }, ...profiles.map((n) => h('option', { key: n, value: n }))),
      h('button', { id: 'foundry-assign', style: btn(true), disabled: !profile.trim() || profile === card.assignee_profile, onClick: () => p.run({ type: 'assign', card_id: card.id, profile: profile.trim() }, `Assigned to ${profile.trim()} (does not start work)`) }, 'Assign')),
    sect('Comment'),
    comments.length ? h('div', null, ...comments.map((c, i) => h('div', { key: i, style: { padding: '3px 0', fontSize: 12 } }, h('b', null, c.author), `: ${c.text}`))) : null,
    h('div', { style: { ...row, flexDirection: 'column' } },
      h('textarea', { id: 'foundry-comment', rows: 3, style: { ...field, resize: 'vertical' }, value: text, placeholder: 'Write a comment…', onChange: (e: any) => setText(e.target.value) }),
      h('button', { id: 'foundry-comment-send', style: { ...btn(true), alignSelf: 'flex-end' }, disabled: !text.trim(), onClick: async () => { if (await p.run({ type: 'comment', card_id: card.id, text: text.trim() }, 'Comment added')) setText('') } }, 'Comment')))
}

function DocView(p: PanelProps & { card: Card; doc: Extract<Pick, { kind: 'doc' }> }) {
  return h('div', null, backLink(p.setPick),
    h('div', { style: { font: `600 15px ${sans}` } }, p.doc.title),
    h('div', { style: { color: C.muted, fontFamily: mono, fontSize: 11, marginTop: 4, wordBreak: 'break-all' } }, p.doc.path),
    h('div', { style: { color: C.muted, marginTop: 8 } }, 'Carved into: ', h('a', { style: { color: C.primary, cursor: 'pointer' }, onClick: () => p.setPick({ kind: 'card', id: p.card.id }) }, p.card.title)),
    h('div', { style: { color: C.muted, marginTop: 12, fontSize: 12 } }, 'The Foundry contract carries the path and title only; the document body is not served to the pane.'))
}

function WorkerView(p: PanelProps & { worker: Worker }) {
  const { worker, snap, setPick } = p
  const [tr, setTr] = useState<TranscriptReply | null>(null)
  const [msg, setMsg] = useState('')
  useEffect(() => {
    setTr(null)
    const load = p.api.transcript
    if (!load) return
    // a reply for a previously selected worker must never show under this one
    return loadUnlessCancelled(() => load.call(p.api, worker.id), setTr)
  }, [worker.id])
  const held = worker.card_id ? findCard(snap, worker.card_id) : undefined
  return h('div', null, backLink(setPick),
    h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
      h('i', { style: { width: 12, height: 12, borderRadius: 6, background: hex(WORKER_COLOR[worker.state]), display: 'inline-block' } }),
      h('div', { style: { font: `600 15px ${sans}` } }, worker.name)),
    h('div', { style: { color: C.muted, marginTop: 6 } }, 'State: ', h('span', { style: { color: C.fg } }, worker.state === 'unknown' ? 'unknown (the source cannot tell)' : worker.state.replace('_', ' '))),
    h('div', { style: { color: C.muted } }, 'Holds: ', held ? h('a', { style: { color: C.primary, cursor: 'pointer' }, onClick: () => setPick({ kind: 'card', id: held.id }) }, held.title) : h('span', { style: { color: C.fg } }, 'nothing')),
    worker.state === 'looping' ? h('div', { style: { marginTop: 8, color: '#ff9fc4' } }, p.simulated ? 'Keeps slipping on one segment and catching a new hold (simulated: the fixture scripts this).' : 'Keeps slipping on one segment and catching a new hold.') : null,
    p.simulated ? h('div', null,
      sect('Simulated controls'),
      h('div', { style: { display: 'flex', gap: 6 } },
        h('input', { style: { ...field, flex: 1 }, value: msg, placeholder: 'Message the climber', onChange: (e: any) => setMsg(e.target.value) }),
        h('button', { style: btn(), disabled: !msg.trim(), onClick: async () => { if (await p.run({ type: 'message', worker_id: worker.id, text: msg.trim() }, 'Message queued')) setMsg('') } }, 'Send')),
      h('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
        h('button', { style: btn(), onClick: () => p.run({ type: 'stand', on: !snap.paused }, snap.paused ? 'Resumed' : 'Standing at the next tool boundary') }, snap.paused ? 'Resume' : 'Stand'))) : null,
    tr ? h('div', null, sect(p.simulated ? 'Transcript (simulated)' : 'Transcript'),
      ...tr.lines.map((l) => h('div', { key: l.seq, style: { padding: '3px 0', fontSize: 12 } }, h('span', { style: { color: C.muted, fontFamily: mono } }, `${l.role} `), l.text))) : null)
}

export default {
  id: 'foundry',
  name: 'Foundry',
  register(ctx: any) {
    ctx.register({ id: 'page', area: ROUTES_AREA, data: { path: '/foundry' }, render: () => jsx(FoundryPage, { rest: ctx.rest }) })
    ctx.register({ id: 'nav', area: SIDEBAR_NAV_AREA, order: 60, data: { codicon: 'beaker', label: 'Foundry', path: '/foundry' } })
  },
}
