import { describe, expect, it, vi } from 'vitest'
import src from '../src/audio.ts?raw'
import { createAudio, CUES, MAX_VOICES, MIN_GAP_MS, STORAGE_KEY, type AudioContextLike, type Cue } from '../src/audio'

/** A recording AudioContext double: counts oscillators and lets a test end them. */
function fakeCtx() {
  const oscs: any[] = []
  const param = () => ({ value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() })
  const ctx = {
    currentTime: 1, destination: { dest: true }, state: 'running',
    createOscillator: () => { const o: any = { type: '', frequency: param(), connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null }; oscs.push(o); return o },
    createGain: () => ({ gain: param(), connect: vi.fn(), disconnect: vi.fn() }),
    resume: vi.fn(async () => {}), close: vi.fn(async () => {}),
  }
  return { ctx: ctx as unknown as AudioContextLike & typeof ctx, oscs }
}
const memStore = (init: Record<string, string> = {}) => { const m = { ...init }; return { getItem: (k: string) => m[k] ?? null, setItem: (k: string, v: string) => { m[k] = v }, m } }

describe('audio cues', () => {
  it('is off by default: no context is created and play is silent', () => {
    const make = vi.fn(() => fakeCtx().ctx)
    const a = createAudio({ makeContext: make, store: memStore() })
    expect(a.enabled()).toBe(false)
    for (const c of Object.keys(CUES) as Cue[]) a.play(c)
    expect(make).not.toHaveBeenCalled()
  })
  it('turning it on makes the context, persists the choice, and plays each cue with its notes', () => {
    const f = fakeCtx(); const store = memStore(); let t = 0
    const a = createAudio({ makeContext: () => f.ctx, store, now: () => (t += 10_000) })
    a.setEnabled(true)
    expect(a.enabled()).toBe(true)
    expect(store.m[STORAGE_KEY]).toBe('1')
    let seen = 0
    for (const c of Object.keys(CUES) as Cue[]) {
      a.play(c)
      seen += CUES[c].length
      expect(f.oscs.length).toBe(seen)
      f.oscs.slice(-CUES[c].length).forEach((o) => { expect(o.start).toHaveBeenCalled(); expect(o.stop).toHaveBeenCalled(); o.onended() })
    }
  })
  it('the same cue is not replayed inside the gap, and voices are capped', () => {
    const f = fakeCtx(); let t = 1000
    const a = createAudio({ makeContext: () => f.ctx, store: memStore(), now: () => t })
    a.setEnabled(true)
    a.play('assign'); a.play('assign')
    expect(f.oscs.length).toBe(CUES.assign.length)
    t += MIN_GAP_MS
    a.play('assign')
    expect(f.oscs.length).toBe(CUES.assign.length * 2)
    // voices never exceed MAX_VOICES when nothing has ended
    for (const c of ['stand', 'slip', 'blocked', 'stand', 'slip'] as Cue[]) { t += 10_000; a.play(c) }
    const started = new Set(f.oscs.map((o) => o)).size
    expect(started).toBeLessThanOrEqual(CUES.assign.length * 2 + MAX_VOICES * 2)
  })
  it('off closes the context, stores "0", and silences; a stored "1" opens lazily on the first cue', async () => {
    const f = fakeCtx(); const store = memStore({ [STORAGE_KEY]: '1' })
    const make = vi.fn(() => f.ctx)
    const a = createAudio({ makeContext: make, store })
    expect(a.enabled()).toBe(true)
    expect(make).not.toHaveBeenCalled()
    a.play('stand')
    expect(make).toHaveBeenCalledTimes(1)
    a.setEnabled(false)
    expect(f.ctx.close).toHaveBeenCalled()
    expect(store.m[STORAGE_KEY]).toBe('0')
    const n = f.oscs.length
    a.play('slip')
    expect(f.oscs.length).toBe(n)
  })
  it('a window with no AudioContext stays off and does not store "on"', () => {
    const store = memStore()
    const a = createAudio({ makeContext: () => null, store })
    a.setEnabled(true)
    expect(a.enabled()).toBe(false)
    expect(store.m[STORAGE_KEY]).toBe('0')
  })
  it('a throwing store does not break the toggle', () => {
    const bad = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    const f = fakeCtx()
    const a = createAudio({ makeContext: () => f.ctx, store: bad })
    expect(a.enabled()).toBe(false)
    a.setEnabled(true)
    expect(a.enabled()).toBe(true)
  })
  it('dispose closes the context', () => {
    const f = fakeCtx()
    const a = createAudio({ makeContext: () => f.ctx, store: memStore() })
    a.setEnabled(true); a.dispose()
    expect(f.ctx.close).toHaveBeenCalled()
  })
  it('uses no network, file or sample: the source only synthesises', () => {
    for (const banned of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'new Audio', 'decodeAudioData', 'createBufferSource', 'createMediaElementSource', 'http:', 'https:', '.mp3', '.wav', '.ogg', 'import(']) {
      expect(src.includes(banned), banned).toBe(false)
    }
  })
})
