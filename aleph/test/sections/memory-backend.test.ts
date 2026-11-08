import { describe, expect, it } from 'vitest'
import { MemorySectionsBackend } from '../../src/sections'
import { runSectionsContract } from './contract'

runSectionsContract('memory backend', async () => ({ backend: new MemorySectionsBackend(), creatures: ['atlas', 'harbor'] }))

describe('memory backend', () => {
  it('uses the id generator it is given and retries a colliding id', async () => {
    const ids = ['s_00000001', 's_00000001', 's_00000002']
    const b = new MemorySectionsBackend(() => ids.shift()!)
    expect((await b.create('atlas', 'A')).id).toBe('s_00000001')
    expect((await b.create('atlas', 'B')).id).toBe('s_00000002')
  })
})
