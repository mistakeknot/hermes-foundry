// Four small cues, synthesised live with WebAudio oscillators. No sample, file, URL or network is involved, so there is
// nothing to license: every sound here is a few sine/triangle notes shaped by a gain envelope.
// Sound is OFF by default. The preference persists in localStorage under `foundry.sound`, but the AudioContext is made
// and resumed only inside a user gesture (the chip click, or the first pointer/key gesture in the pane via `activate()`),
// so the browser's autoplay rule is met; cues that arrive before that gesture are dropped. The context is closed when the
// pane unmounts, and a disposed instance never sounds or opens a context again.

export type Cue = 'assign' | 'stand' | 'slip' | 'blocked'

/** The slice of AudioContext the cues use; a test supplies a recording double. */
export interface AudioContextLike {
  readonly currentTime: number
  readonly destination: unknown
  readonly state?: string
  createOscillator(): OscillatorLike
  createGain(): GainLike
  resume?(): Promise<void>
  close?(): Promise<void>
}
interface ParamLike {
  value: number
  setValueAtTime(v: number, t: number): unknown
  linearRampToValueAtTime(v: number, t: number): unknown
  exponentialRampToValueAtTime(v: number, t: number): unknown
}
export interface OscillatorLike {
  type: string
  frequency: ParamLike
  connect(n: unknown): unknown
  disconnect?(): void
  start(t?: number): void
  stop(t?: number): void
  onended: (() => void) | null
}
export interface GainLike { gain: ParamLike; connect(n: unknown): unknown; disconnect?(): void }
export interface StoreLike { getItem(k: string): string | null; setItem(k: string, v: string): void }

export const STORAGE_KEY = 'foundry.sound'
/** Quiet by design: the cues sit under conversation, not over it. */
export const MASTER_GAIN = 0.12
/** The same cue is not replayed inside this window (a poll that flips several cards must not machine-gun). */
export const MIN_GAP_MS = 400
/** At most this many cues sound at once; extra ones are dropped. */
export const MAX_VOICES = 4

interface Note { f0: number; f1?: number; at: number; dur: number; type: 'sine' | 'triangle'; peak: number; swell?: boolean }

/** Cue designs, as notes: start/end frequency (Hz), offset and length (s), waveform, peak gain. */
export const CUES: Record<Cue, Note[]> = {
  // assign: two soft rising notes, a perfect fifth apart (a handing-over)
  assign: [
    { f0: 523.25, at: 0, dur: 0.16, type: 'sine', peak: 0.8 },
    { f0: 783.99, at: 0.09, dur: 0.24, type: 'sine', peak: 0.7 },
  ],
  // stand: a low bell that settles (the valley holds still)
  stand: [
    { f0: 196, at: 0, dur: 0.9, type: 'sine', peak: 0.9 },
    { f0: 98, at: 0, dur: 1.1, type: 'sine', peak: 0.5 },
  ],
  // slip: a quick downward glide with a small upward catch at the end
  slip: [
    { f0: 660, f1: 240, at: 0, dur: 0.26, type: 'triangle', peak: 0.7 },
    { f0: 360, f1: 520, at: 0.28, dur: 0.1, type: 'sine', peak: 0.45 },
  ],
  // blocked: two close sines beating slowly, swelling in and out like an ember
  blocked: [
    { f0: 329.63, at: 0, dur: 0.8, type: 'sine', peak: 0.6, swell: true },
    { f0: 333.5, at: 0, dur: 0.8, type: 'sine', peak: 0.6, swell: true },
  ],
}

export interface FoundryAudio {
  /** The saved preference (on/off). A restored "on" sounds only after `activate()`. */
  enabled(): boolean
  /** True when a context exists, so cues can sound now. */
  active(): boolean
  /** Turning on creates the context (call it from a click). Turning off closes it. No-op once disposed. */
  setEnabled(on: boolean): void
  /** Call from a user gesture: creates/resumes the context when the preference is on. No-op otherwise or once disposed. */
  activate(): void
  play(cue: Cue): void
  /** Closes the context for good: nothing sounds or opens afterwards, even if a late event calls play(). */
  dispose(): void
}

export interface AudioDeps {
  makeContext?: () => AudioContextLike | null
  store?: StoreLike | null
  now?: () => number
}

function defaultContext(): AudioContextLike | null {
  const C = (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext
  if (!C) return null
  return new C() as AudioContextLike
}
function defaultStore(): StoreLike | null {
  try { return (globalThis as any).localStorage ?? null } catch { return null }
}

/** Run an audio call that may throw synchronously or return a promise that rejects; neither may escape. */
function safely(f: () => unknown): void {
  try {
    const r = f() as { catch?: (g: () => void) => unknown } | undefined
    if (r && typeof r.catch === 'function') r.catch(() => {})
  } catch { /* a closed or broken context: the cue is simply lost */ }
}

export function createAudio(deps: AudioDeps = {}): FoundryAudio {
  const makeContext = deps.makeContext ?? defaultContext
  const store = deps.store === undefined ? defaultStore() : deps.store
  const now = deps.now ?? (() => Date.now())
  let on = false
  let disposed = false
  let ctx: AudioContextLike | null = null
  let master: GainLike | null = null
  let voices = 0
  const lastAt = new Map<Cue, number>()

  const read = (): boolean => { try { return store?.getItem(STORAGE_KEY) === '1' } catch { return false } }
  const write = (v: boolean) => { try { store?.setItem(STORAGE_KEY, v ? '1' : '0') } catch { /* private mode: the choice just does not persist */ } }

  const open = () => {
    if (ctx || disposed) return
    let c: AudioContextLike | null = null
    try { c = makeContext() } catch { c = null }
    if (!c) { on = false; return }
    try {
      const m = c.createGain()
      m.gain.value = MASTER_GAIN
      m.connect(c.destination)
      master = m
    } catch {
      safely(() => c!.close?.())
      on = false
      return
    }
    ctx = c
  }
  const close = () => {
    const c = ctx
    ctx = null; master = null; voices = 0
    if (c) safely(() => c.close?.())
  }
  const wake = () => { if (ctx && ctx.state === 'suspended') safely(() => ctx!.resume?.()) }

  // The saved preference is restored now, but no context is made until a gesture calls activate().
  on = read()

  function play(cue: Cue) {
    if (disposed || !on) return
    const c = ctx, m = master
    if (!c || !m) return // not activated by a gesture yet: drop the cue rather than start audio unprompted
    const t = now()
    const last = lastAt.get(cue)
    if (last !== undefined && t - last < MIN_GAP_MS) return
    if (voices >= MAX_VOICES) return
    lastAt.set(cue, t)
    voices++
    let pending = CUES[cue].length
    const done = () => { if (--pending === 0) voices = Math.max(0, voices - 1) }
    try {
      const t0 = c.currentTime
      for (const n of CUES[cue]) {
        const osc = c.createOscillator(), g = c.createGain()
        osc.type = n.type
        const s = t0 + n.at, e = s + n.dur
        osc.frequency.setValueAtTime(n.f0, s)
        if (n.f1) osc.frequency.exponentialRampToValueAtTime(n.f1, e)
        g.gain.setValueAtTime(0.0001, s)
        if (n.swell) {
          g.gain.linearRampToValueAtTime(n.peak, s + n.dur * 0.45)
          g.gain.linearRampToValueAtTime(0.0001, e)
        } else {
          g.gain.linearRampToValueAtTime(n.peak, s + 0.012)
          g.gain.exponentialRampToValueAtTime(0.0001, e)
        }
        osc.connect(g); g.connect(m)
        osc.onended = () => { safely(() => { osc.disconnect?.(); g.disconnect?.() }); done() }
        osc.start(s)
        osc.stop(e + 0.02)
      }
    } catch {
      voices = Math.max(0, voices - 1) // a broken or closed context: give the voice back; the cue is lost
    }
  }

  return {
    enabled: () => on,
    active: () => ctx !== null,
    setEnabled(v) {
      if (disposed) return
      on = v
      if (v) { open(); wake() } else close()
      write(on) // `on` is false again when the window has no audio, so an unsupported window never stores "on"
    },
    activate() {
      if (disposed || !on) return
      if (!ctx) open()
      wake()
    },
    play,
    dispose() { disposed = true; on = false; close() },
  }
}
