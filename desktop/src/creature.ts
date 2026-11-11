// Deterministic procedural creature builder. Pure data out (no three.js), so it is unit-testable.
// A project is a creature: epics are limbs, cards are scales on the limb, docs are carvings.
// Everything is derived from the project id and the (id-sorted) cards, never from status or time,
// so a status change recolours a scale but never moves anything.
import { hashString, rng } from './rng'
import type { Card, Project } from './types'
import { knownStatus } from './status-look'
import lineageData from '../data/jawnomicon-v50.json'

export type V3 = [number, number, number]
export type Material = 'stone' | 'lichen' | 'coral'

export interface Lineage {
  readonly id: string
  readonly name: string
  readonly motifs: readonly string[]
  readonly eidogen: Readonly<Record<string, number | 'not-applicable'>>
}
export interface LineageSelection { name?: string; reroll?: number }
export type CreatureProject = Project & { lineage?: LineageSelection | null }

export const LINEAGES: readonly Lineage[] = Object.freeze((lineageData as Lineage[]).map(c =>
  Object.freeze({ ...c, motifs: Object.freeze(c.motifs), eidogen: Object.freeze(c.eidogen) })))

/** Persist a name/id or re-roll counter in the host's project preferences. No mutable global RNG. */
export function pickLineage(projectId: string, selection: LineageSelection = {}, catalogue: readonly Lineage[] = LINEAGES): Lineage | undefined {
  const ordered = [...catalogue].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  if (!ordered.length) return undefined
  if (selection.name !== undefined) {
    const name = selection.name.trim().toLowerCase()
    return ordered.find(c => c.id.toLowerCase() === name || c.name.toLowerCase() === name)
  }
  const roll = Number.isSafeInteger(selection.reroll) ? selection.reroll! : 0
  // Adjacent re-rolls always move to another creature, until the catalogue wraps.
  const index = ((hashString(projectId) % ordered.length) + (roll % ordered.length) + ordered.length) % ordered.length
  return ordered[index]
}

/** Design choice: motif families deform the existing abstract body; no extra limbs steal section ownership. */
export function lineageTraits(c: Lineage): { stretch: V3; lift: number; reach: number; sway: number; lumps: number; material: Material } {
  const motifs = c.motifs.join(' ')
  const wing = /wing|firebird|eagle|avian|bird/.test(motifs)
  const coil = /snake|serpent|worm|tentacle|octopus/.test(motifs)
  const solid = /stone|clay|giant|dwarf/.test(motifs)
  const crown = /horn|antler|many-head|multi.*head/.test(motifs)
  const dim = (key: string) => {
    const value = c.eidogen[key]
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5
  }
  // The whole 29-dimension vector contributes to fullness; non-applicable is neutral.
  const keys = Object.keys(c.eidogen).sort()
  const fullness = keys.length ? keys.reduce((sum, k) => sum + dim(k), 0) / keys.length : 0.5
  const warmth = (dim('Emotional Processing') + dim('Empathy') + dim('Nurturing')) / 3
  return {
    stretch: [0.8 + fullness * 0.4 + (wing ? 0.35 : 0),
      0.75 + dim('Resilience') * 0.5 + (solid ? 0.2 : 0) - (coil ? 0.2 : 0),
      Math.min(1.4, 0.8 + dim('Manifestation') * 0.4 + (coil ? 0.4 : 0))],
    lift: wing ? 1.4 : coil ? 0.65 : 1,
    // Keep large serpentine boards inside the existing narrow-pane camera envelope.
    reach: Math.min(1.15, 0.8 + dim('Scope of Focus') * 0.4 + (coil ? 0.25 : 0)),
    sway: 0.6 + dim('Adaptability') * 0.8 + (coil ? 0.4 : 0),
    lumps: crown ? 8 : solid ? 4 : wing ? 6 : 5,
    material: warmth < 0.45 ? 'stone' : warmth < 0.6 ? 'lichen' : 'coral',
  }
}

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
  lineage?: { id: string; name: string }
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
/** Cards one limb carries before the epic's cards are spread over more limbs, and the most limbs one epic is spread over. */
export const LIMB_MAX = 12
export const MAX_SPLIT = 6
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

export function buildCreature(project: CreatureProject): CreatureSpec {
  const seed = hashString(project.id)
  const r = rng(seed)
  const lineage = project.lineage === null ? undefined : pickLineage(project.id, project.lineage)
  const traits = lineage && lineageTraits(lineage)
  const cards = [...project.cards].sort((a, b) => natCompare(a.id, b.id))

  const torsoR: V3 = [2.2 + r() * 0.9, 1.6 + r() * 0.8, 2.0 + r() * 0.9]
  if (traits) for (let i = 0; i < 3; i++) torsoR[i] *= traits.stretch[i]
  const lumps = Array.from({ length: traits?.lumps ?? 5 }, () => {
    const a = r() * Math.PI * 2
    const e = (r() - 0.3) * 1.2
    return { pos: r3([Math.cos(a) * torsoR[0] * 0.8, Math.sin(e) * torsoR[1] * 0.9, Math.sin(a) * torsoR[2] * 0.8] as V3), r: round(0.5 + r() * 0.7) }
  })
  const randomMaterial = MATERIALS[Math.floor(r() * 3)]
  const torsoMat = traits?.material ?? randomMaterial

  const byEpic = new Map<string | null, Card[]>()
  for (const e of project.epics) byEpic.set(e.id, [])
  for (const c of cards) {
    const key = c.epic_id && byEpic.has(c.epic_id) ? c.epic_id : null
    byEpic.set(key, [...(byEpic.get(key) ?? []), c])
  }
  if (!byEpic.get(null)?.length) byEpic.delete(null) // a stray limb only when there are stray cards

  // An epic with many cards is spread over several limbs (see LIMB_MAX), so one big board does not become a single long,
  // heaped limb. The split follows the id order, so a status change still moves nothing.
  const parts: { epicId: string | null; list: Card[]; part: number; of: number }[] = []
  for (const [epicId, all] of byEpic) {
    const of = Math.min(MAX_SPLIT, Math.max(1, Math.ceil(all.length / LIMB_MAX)))
    const per = Math.ceil(all.length / of)
    for (let k = 0; k < of; k++) parts.push({ epicId, list: all.slice(k * per, (k + 1) * per), part: k, of })
  }
  const nLimb = parts.length
  const limbs: LimbSpec[] = parts.map(({ epicId, list, part, of }, li) => {
    const lr = rng(hashString(part === 0 ? `${project.id}/${epicId ?? '_'}` : `${project.id}/${epicId ?? '_'}/${part}`))
    const name = project.epics.find((e) => e.id === epicId)?.title ?? 'Unsorted'
    const title = of > 1 ? `${name} (${part + 1}/${of})` : name
    const theta = (li / nLimb) * Math.PI * 2 + (lr() - 0.5) * 0.35
    const base: V3 = [Math.cos(theta) * torsoR[0] * 0.85, (lr() - 0.5) * torsoR[1] * 0.6, Math.sin(theta) * torsoR[2] * 0.85]
    const length = Math.min(3 + 0.55 * Math.sqrt(list.length) * 2.2, 9) * (traits?.reach ?? 1)
    const rise = (0.35 + lr() * 0.5) * (traits?.lift ?? 1)
    const N = 7
    const out: V3 = [Math.cos(theta), 0, Math.sin(theta)]
    const side: V3 = [-Math.sin(theta), 0, Math.cos(theta)]
    const wob = (0.6 + lr() * 1.1) * (traits?.sway ?? 1)
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
    const randomLimbMaterial = MATERIALS[Math.floor(lr() * 3)]
    const material = traits?.material ?? randomLimbMaterial

    const counts = emptyCounts()
    const scales: ScaleSpec[] = list.map((c, i) => {
      counts[knownStatus(c.status)]++
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
  return { projectId: project.id, name: project.name, seed, ...(lineage ? { lineage: { id: lineage.id, name: lineage.name } } : {}), torso: { radii: r3(torsoR), lumps, material: torsoMat }, limbs, height: round(height), radius: round(radius) }
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
