import { describe, expect, it } from 'vitest'
import { loadUnlessCancelled } from '../src/stale'

const deferred = <T,>() => { let res!: (v: T) => void, rej!: (e: unknown) => void; const p = new Promise<T>((a, b) => { res = a; rej = b }); return { p, res, rej } }
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('loadUnlessCancelled (transcript effect)', () => {
  it('reversed response order: A selected, B selected, B resolves then A; only B is shown', async () => {
    const shown: (string | null)[] = []
    const a = deferred<string>(), b = deferred<string>()
    const cancelA = loadUnlessCancelled(() => a.p, (v) => shown.push(v))
    cancelA() // effect cleanup when worker B is selected
    loadUnlessCancelled(() => b.p, (v) => shown.push(v))
    b.res('B'); await tick()
    a.res('A'); await tick()
    expect(shown).toEqual(['B'])
  })
  it('a cancelled request that rejects does not clear the newer value', async () => {
    const shown: (string | null)[] = []
    const a = deferred<string>(), b = deferred<string>()
    const cancelA = loadUnlessCancelled(() => a.p, (v) => shown.push(v))
    cancelA()
    loadUnlessCancelled(() => b.p, (v) => shown.push(v))
    b.res('B'); await tick()
    a.rej(new Error('late')); await tick()
    expect(shown).toEqual(['B'])
  })
  it('applies null on failure when not cancelled, and nothing after unmount', async () => {
    const shown: (string | null)[] = []
    const a = deferred<string>()
    loadUnlessCancelled(() => a.p, (v) => shown.push(v))
    a.rej(new Error('x')); await tick()
    expect(shown).toEqual([null])
    const c = deferred<string>()
    const off = loadUnlessCancelled(() => c.p, (v) => shown.push(v))
    off(); c.res('late'); await tick()
    expect(shown).toEqual([null])
  })
})
