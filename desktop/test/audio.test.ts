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
  it('off closes the context, stores "0", and silences', () => {
    const f = fakeCtx(); const store = memStore()
    const a = createAudio({ makeContext: () => f.ctx, store })
    a.setEnabled(true)
    a.setEnabled(false)
    expect(f.ctx.close).toHaveBeenCalled()
    expect(store.m[STORAGE_KEY]).toBe('0')
    expect(a.active()).toBe(false)
    const n = f.oscs.length
    a.play('slip')
    expect(f.oscs.length).toBe(n)
  })
  it('a saved "on" is only a preference: no context and no sound until a gesture calls activate()', () => {
    const f = fakeCtx(); const store = memStore({ [STORAGE_KEY]: '1' })
    const make = vi.fn(() => f.ctx)
    const a = createAudio({ makeContext: make, store })
    expect(a.enabled()).toBe(true)
    expect(a.active()).toBe(false)
    a.play('stand'); a.play('assign')       // automatic cues before any gesture
    expect(make).not.toHaveBeenCalled()
    expect(f.ctx.resume).not.toHaveBeenCalled()
    expect(f.oscs.length).toBe(0)
    a.activate()                              // the first pointer/key gesture
    expect(make).toHaveBeenCalledTimes(1)
    expect(a.active()).toBe(true)
    a.play('stand')
    expect(f.oscs.length).toBe(CUES.stand.length)
  })
  it('activate() with the preference off does nothing, and resumes a suspended context from a gesture only', () => {
    const f = fakeCtx(); const make = vi.fn(() => f.ctx)
    const off = createAudio({ makeContext: make, store: memStore() })
    off.activate()
    expect(make).not.toHaveBeenCalled()
    const on = createAudio({ makeContext: make, store: memStore() })
    on.setEnabled(true)
    ;(f.ctx as any).state = 'suspended'
    f.ctx.resume.mockClear()
    on.play('assign')                         // an automatic cue never resumes
    expect(f.ctx.resume).not.toHaveBeenCalled()
    on.activate()                             // a gesture does
    expect(f.ctx.resume).toHaveBeenCalledTimes(1)
  })
  it('dispose is permanent: a late play/setEnabled/activate neither sounds nor opens a context', () => {
    const f = fakeCtx(); const make = vi.fn(() => f.ctx); const store = memStore()
    const a = createAudio({ makeContext: make, store })
    a.setEnabled(true); a.dispose()
    expect(make).toHaveBeenCalledTimes(1)
    expect(a.enabled()).toBe(false)
    const n = f.oscs.length
    a.play('assign'); a.setEnabled(true); a.activate(); a.play('assign')
    expect(make).toHaveBeenCalledTimes(1)
    expect(f.oscs.length).toBe(n)
    expect(a.active()).toBe(false)
    expect(store.m[STORAGE_KEY]).toBe('1')    // disposing does not erase the saved choice
  })
  it('a resume() that throws or rejects, and a close() that throws or rejects, never escape', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown) => unhandled.push(e);
    (globalThis as any).process.on('unhandledRejection', onUnhandled)
    try {
      for (const mode of ['throw', 'reject'] as const) {
        const f = fakeCtx()
        ;(f.ctx as any).state = 'suspended'
        f.ctx.resume = (mode === 'throw' ? vi.fn(() => { throw new Error('resume') }) : vi.fn(() => Promise.reject(new Error('resume')))) as any
        f.ctx.close = (mode === 'throw' ? vi.fn(() => { throw new Error('close') }) : vi.fn(() => Promise.reject(new Error('close')))) as any
        const a = createAudio({ makeContext: () => f.ctx, store: memStore() })
        expect(() => a.setEnabled(true)).not.toThrow()
        expect(() => a.activate()).not.toThrow()
        expect(() => a.setEnabled(false)).not.toThrow()
        a.setEnabled(true)
        expect(() => a.dispose()).not.toThrow()
        expect(f.ctx.resume).toHaveBeenCalled()
        expect(f.ctx.close).toHaveBeenCalled()
      }
      await new Promise((r) => setTimeout(r, 20))
      expect(unhandled).toEqual([])
    } finally { (globalThis as any).process.off('unhandledRejection', onUnhandled) }
  })
  it('a context that throws while building a cue loses the cue but not the voice slot, and later cues still work', () => {
    const f = fakeCtx(); let t = 0
    const a = createAudio({ makeContext: () => f.ctx, store: memStore(), now: () => (t += 10_000) })
    a.setEnabled(true)
    const real = f.ctx.createOscillator
    f.ctx.createOscillator = (() => { throw new Error('closed') }) as any
    for (let i = 0; i < MAX_VOICES + 2; i++) expect(() => a.play('assign')).not.toThrow()
    f.ctx.createOscillator = real
    a.play('assign')                          // the slots were given back, so this still sounds
    expect(f.oscs.length).toBe(CUES.assign.length)
  })
  it('a makeContext that throws leaves sound off and unstored', () => {
    const store = memStore()
    const a = createAudio({ makeContext: () => { throw new Error('no audio') }, store })
    expect(() => a.setEnabled(true)).not.toThrow()
    expect(a.enabled()).toBe(false)
    expect(store.m[STORAGE_KEY]).toBe('0')
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
