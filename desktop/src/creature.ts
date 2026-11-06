// Deterministic procedural creature builder. Pure data out (no three.js), so it is unit-testable.
// A project is a creature: epics are limbs, cards are scales on the limb, docs are carvings.
// Everything is derived from the project id and the (id-sorted) cards, never from status or time,
// so a status change recolours a scale but never moves anything.
import { hashString, rng } from './rng'
import type { Card, Project } from './types'

export type V3 = [number, number, number]
export type Material = 'stone' | 'lichen' | 'coral'

export interface ScaleSpec { cardId: string; epicId: string | null; pos: V3; normal: V3; size: number }
export interface CarvingSpec { docPath: string; title: string; cardId: string; pos: V3; normal: V3; glyph: number; size: number }
export interface LimbSpec {
  epicId: string | null
  title: string
  material: Material
  path: V3[] // centreline, torso end first
  radii: number[] // per path point
  scales: ScaleSpec[]
  carvings: CarvingSpec[]
  counts: Record<Card['status'], number>
}
export interface CreatureSpec {
  projectId: string
  name: string
  seed: number
  torso: { radii: V3; lumps: { pos: V3; r: number }[]; material: Material }
  limbs: LimbSpec[]
  height: number // top of the tallest limb, for camera framing
  radius: number // footprint radius
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]
const len = (a: V3) => Math.hypot(a[0], a[1], a[2])
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l] }
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const GOLDEN = 2.399963229728653
const MATERIALS: Material[] = ['stone', 'lichen', 'coral']

function round(v: number) { return Math.round(v * 1e5) / 1e5 }
const r3 = (v: V3): V3 => [round(v[0]), round(v[1]), round(v[2])]

/** Natural-order compare so "t2" < "t10". */
export function natCompare(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true })
}

const emptyCounts = (): Record<Card['status'], number> => ({ open: 0, running: 0, blocked: 0, review: 0, done: 0, unknown: 0 })

/** Frame (two unit vectors perpendicular to the tangent) at path param. */
export function frameAt(path: V3[], t: number): { p: V3; n1: V3; n2: V3; tan: V3; seg: number } {
  const n = path.length - 1
  const f = Math.min(Math.max(t, 0), 1) * n
  const seg = Math.min(Math.floor(f), n - 1)
  const u = f - seg
  const p = add(mul(path[seg], 1 - u), mul(path[seg + 1], u))
  const tan = norm(sub(path[seg + 1], path[seg]))
  const up: V3 = Math.abs(tan[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0]
  const n1 = norm(cross(tan, up))
  const n2 = norm(cross(tan, n1))
  return { p, n1, n2, tan, seg }
}
export function radiusAt(radii: number[], t: number): number {
  const n = radii.length - 1
  const f = Math.min(Math.max(t, 0), 1) * n
  const seg = Math.min(Math.floor(f), n - 1)
  const u = f - seg
  return radii[seg] * (1 - u) + radii[seg + 1] * u
}

export function buildCreature(project: Project): CreatureSpec {
  const seed = hashString(project.id)
  const r = rng(seed)
  const cards = [...project.cards].sort((a, b) => natCompare(a.id, b.id))

  const torsoR: V3 = [2.2 + r() * 0.9, 1.6 + r() * 0.8, 2.0 + r() * 0.9]
  const lumps = Array.from({ length: 5 }, () => {
    const a = r() * Math.PI * 2
    const e = (r() - 0.3) * 1.2
    return { pos: r3([Math.cos(a) * torsoR[0] * 0.8, Math.sin(e) * torsoR[1] * 0.9, Math.sin(a) * torsoR[2] * 0.8] as V3), r: round(0.5 + r() * 0.7) }
  })
  const torsoMat = MATERIALS[Math.floor(r() * 3)]

  const byEpic = new Map<string | null, Card[]>()
  for (const e of project.epics) byEpic.set(e.id, [])
  for (const c of cards) {
    const key = c.epic_id && byEpic.has(c.epic_id) ? c.epic_id : null
    byEpic.set(key, [...(byEpic.get(key) ?? []), c])
  }
  if (!byEpic.get(null)?.length) byEpic.delete(null) // a stray limb only when there are stray cards

  const keys = [...byEpic.keys()]
  const nLimb = keys.length
  const limbs: LimbSpec[] = keys.map((epicId, li) => {
    const lr = rng(hashString(`${project.id}/${epicId ?? '_'}`))
    const list = byEpic.get(epicId)!
    const title = project.epics.find((e) => e.id === epicId)?.title ?? 'Unsorted'
    const theta = (li / nLimb) * Math.PI * 2 + (lr() - 0.5) * 0.35
    const base: V3 = [Math.cos(theta) * torsoR[0] * 0.85, (lr() - 0.5) * torsoR[1] * 0.6, Math.sin(theta) * torsoR[2] * 0.85]
    const length = Math.min(3 + 0.55 * Math.sqrt(list.length) * 2.2, 9)
    const rise = 0.35 + lr() * 0.5
    const N = 7
    const out: V3 = [Math.cos(theta), 0, Math.sin(theta)]
    const side: V3 = [-Math.sin(theta), 0, Math.cos(theta)]
    const wob = 0.6 + lr() * 1.1
    const ph = lr() * 6.28
    const path: V3[] = []
    for (let k = 0; k <= N; k++) {
      const s = k / N
      const along = mul(out, s * length)
      const lift: V3 = [0, Math.sin(s * Math.PI * 0.62) * length * rise, 0]
      const sway = mul(side, Math.sin(s * 4 + ph) * wob * s)
      path.push(r3(add(add(base, along), add(lift, sway))))
    }
    const baseR = Math.min(0.55 + 0.06 * Math.sqrt(list.length), 1.1)
    const radii = path.map((_, k) => round(baseR * (1 - 0.72 * (k / N)) + 0.05))
    const material = MATERIALS[Math.floor(lr() * 3)]

    const counts = emptyCounts()
    const scales: ScaleSpec[] = list.map((c, i) => {
      counts[c.status]++
      const t = 0.08 + 0.9 * ((i + 0.5) / list.length)
      const f = frameAt(path, t)
      const phi = i * GOLDEN
      const normal = norm(add(mul(f.n1, Math.cos(phi)), mul(f.n2, Math.sin(phi))))
      const rr = radiusAt(radii, t)
      // scale size follows the limb's girth and the spacing along it, so it stays legible as cards grow
      const spacing = (length * 0.9) / list.length
      const size = Math.max(0.1, Math.min(rr * 0.9, spacing * 1.6))
      return { cardId: c.id, epicId, pos: r3(add(f.p, mul(normal, rr * 0.92))), normal: r3(normal), size: round(size) }
    })
    const carvings: CarvingSpec[] = []
    list.forEach((c, i) => {
      c.docs.forEach((d, j) => {
        const t = 0.1 + 0.8 * ((i + 0.5) / list.length)
        const f = frameAt(path, t)
        const phi = i * GOLDEN + Math.PI + j * 0.6 // opposite side from the card's scale
        const normal = norm(add(mul(f.n1, Math.cos(phi)), mul(f.n2, Math.sin(phi))))
        const rr = radiusAt(radii, t)
        carvings.push({ docPath: d.path, title: d.title, cardId: c.id, pos: r3(add(f.p, mul(normal, rr * 0.97))), normal: r3(normal), glyph: hashString(d.path) % 6, size: round(Math.max(0.14, rr * 0.5)) })
      })
    })
    return { epicId, title, material, path, radii, scales, carvings, counts }
  })

  let height = torsoR[1]
  let radius = Math.max(torsoR[0], torsoR[2])
  for (const l of limbs) for (const p of l.path) { height = Math.max(height, p[1]); radius = Math.max(radius, Math.hypot(p[0], p[2])) }
  return { projectId: project.id, name: project.name, seed, torso: { radii: r3(torsoR), lumps, material: torsoMat }, limbs, height: round(height), radius: round(radius) }
}

/** Valley layout: creatures on a loose ring (or a line for one), deterministic from id order. */
export function layoutCreatures(specs: CreatureSpec[]): V3[] {
  const n = specs.length
  if (n === 0) return []
  if (n === 1) return [[0, 0, 0]]
  const maxR = Math.max(...specs.map((s) => s.radius))
  const ring = Math.max(maxR * 1.9, (maxR * 2.3 * n) / (2 * Math.PI))
  return specs.map((s, i) => {
    const a = (i / n) * Math.PI * 2 + (rng(s.seed)() - 0.5) * 0.25
    return r3([Math.cos(a) * ring, 0, Math.sin(a) * ring])
  })
}
