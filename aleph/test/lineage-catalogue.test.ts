import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { LINEAGES } from '../../desktop/src/creature'
import { LINEAGE_NAMES } from '../src/lineage/catalogue'

describe('server lineage catalogue', () => {
  it('matches the catalogue the pane uses', () => {
    expect(LINEAGE_NAMES.map(l => ({ id: l.id, name: l.name }))).toEqual(LINEAGES.map(l => ({ id: l.id, name: l.name })))
  })
})

// bb refuses to install a plugin whose server bundle imports outside the plugin directory.
/** Every module specifier in a source file: import, export-from, import-equals, require and import(). */
export function moduleSpecifiers(source: string): string[] {
  const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const out: string[] = []
  const lit = (n: ts.Node | undefined): void => {
    if (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))) out.push(n.text)
  }
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) lit(n.moduleSpecifier)
    else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) lit(n.moduleReference.expression)
    else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) lit(n.argument.literal)
    else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) lit(n.arguments[0])
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

describe('moduleSpecifiers', () => {
  it('finds every import form', () => {
    const src = [
      "import a from '../a'", "import type { B } from '../b'", "import '../c'", "export * from '../d'", "export { e } from '../e'",
      "import f = require('../f')", "const g = require('../g')", "const h = await import('../h')", "const i = await import(`../i`)",
      "import /* c */ j from /* c */ '../j'", "type K = import('../k').K",
    ].join('\n')
    expect(moduleSpecifiers(src).sort()).toEqual(['../a', '../b', '../c', '../d', '../e', '../f', '../g', '../h', '../i', '../j', '../k'])
  })
  it('ignores bare specifiers and strings that only look like imports', () => {
    expect(moduleSpecifiers("import x from 'node:path'; const s = \"import y from '../no'\"")).toEqual(['node:path'])
  })
})

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
    for (const spec of moduleSpecifiers(readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) continue
      const target = resolveFile(file, spec)
      const abs = target ?? resolve(dirname(file), spec)
      if (!abs.startsWith(root + '/')) { escapes.push(`${file.slice(root.length + 1)} -> ${spec}`); continue }
      if (target) walk(target)
    }
  }
  it('has no relative import that leaves aleph/', () => {
    walk(join(root, 'server.ts'))
    expect(seen.size).toBeGreaterThan(1)
    expect(escapes).toEqual([])
  })
})
