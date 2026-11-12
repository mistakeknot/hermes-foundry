import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LINEAGES } from '../../desktop/src/creature'
import { LINEAGE_NAMES } from '../src/lineage/catalogue'

describe('server lineage catalogue', () => {
  it('matches the catalogue the pane uses', () => {
    expect(LINEAGE_NAMES.map(l => ({ id: l.id, name: l.name }))).toEqual(LINEAGES.map(l => ({ id: l.id, name: l.name })))
  })
})

// bb refuses to install a plugin whose server bundle imports outside the plugin directory.
describe('server bundle stays inside the plugin directory', () => {
  const root = resolve(__dirname, '..')
  const seen = new Set<string>()
  const escapes: string[] = []
  const resolveFile = (from: string, spec: string): string | undefined => {
    const base = resolve(dirname(from), spec)
    for (const c of [base, base + '.ts', base + '.tsx', join(base, 'index.ts')]) {
      try { if (statSync(c).isFile()) return c } catch { /* next */ }
    }
    return undefined
  }
  const walk = (file: string): void => {
    if (seen.has(file)) return
    seen.add(file)
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.[^'"]*)['"]/g)) {
      const target = resolveFile(file, m[1])
      const abs = target ?? resolve(dirname(file), m[1])
      if (!abs.startsWith(root + '/')) { escapes.push(`${file.slice(root.length + 1)} -> ${m[1]}`); continue }
      if (target) walk(target)
    }
  }
  it('has no relative import that leaves aleph/', () => {
    walk(join(root, 'server.ts'))
    expect(seen.size).toBeGreaterThan(1)
    expect(escapes).toEqual([])
  })
})
