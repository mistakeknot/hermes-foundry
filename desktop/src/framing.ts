// Camera framing and label placement for the valley. Pure maths (no DOM, no renderer) so tests can check the result
// without WebGL. The scene calls these; nothing here changes the contract.
import * as THREE from 'three'
import type { CreatureSpec } from './creature'

/** Pixels at the top of the pane that belong to the header (title and legend chips). Nothing is framed or labelled there. */
export const HEADER_PX = 52
/** Breathing room at the other three edges, in pixels. */
export const EDGE_PX = 28

/**
 * Points that bound one creature as drawn: along every limb (offset by the limb's own thickness), the torso, and the spot
 * above each limb tip where its label sits. Uses the real limb paths, so a creature with a short reach does not leave
 * the camera holding back for a footprint it never fills.
 */
export function creaturePoints(center: THREE.Vector3, spec: CreatureSpec): THREE.Vector3[] {
  const pts: THREE.Vector3[] = []
  const lift = spec.torso.radii[1] * 0.5
  const ring = (x: number, y: number, z: number, r: number) => {
    pts.push(new THREE.Vector3(center.x + x + r, y, center.z + z), new THREE.Vector3(center.x + x - r, y, center.z + z),
      new THREE.Vector3(center.x + x, y, center.z + z + r), new THREE.Vector3(center.x + x, y, center.z + z - r))
  }
  const tr = Math.max(spec.torso.radii[0], spec.torso.radii[2])
  ring(0, 0, 0, tr)
  ring(0, spec.torso.radii[1] * 2, 0, tr)
  for (const limb of spec.limbs) {
    limb.path.forEach((p, i) => {
      const r = limb.radii[Math.min(i, limb.radii.length - 1)] ?? 0.5
      ring(p[0], Math.max(0, p[1] + lift - r), p[2], r)
      ring(p[0], p[1] + lift + r, p[2], r)
    })
    const tip = limb.path[limb.path.length - 1]
    pts.push(new THREE.Vector3(center.x + tip[0], tip[1] + lift + (limb.radii.at(-1) ?? 0.5) + 1.2, center.z + tip[2]))
  }
  return pts
}

/** Smallest free rectangle (pixels) worth framing into. Below it the edge margins give way before the header does. */
export const MIN_FREE_PX = 8

export interface NdcLimits {
  x: number
  yTop: number
  yBottom: number
  /** false when the header leaves no room: the pane is then framed edge to edge and the header necessarily covers part of it */
  usable: boolean
}

/**
 * Largest |ndc| the framed points may reach on each axis for a pane of w x h pixels. The free rectangle is the pane less the
 * header band at the top and EDGE_PX at the other three sides. On a pane too small for those margins, the side and bottom
 * margins shrink (to zero if need be) so a free rectangle of at least MIN_FREE_PX remains and the header is still cleared.
 * If even that is impossible (the header covers the pane), `usable` is false and the whole pane is used.
 */
export function ndcLimits(w: number, h: number): NdcLimits {
  if (!(w >= MIN_FREE_PX) || !(h - HEADER_PX >= MIN_FREE_PX)) return { x: 1, yTop: 1, yBottom: 1, usable: false }
  const mx = Math.min(EDGE_PX, (w - MIN_FREE_PX) / 2)
  const mb = Math.min(EDGE_PX, h - HEADER_PX - MIN_FREE_PX)
  return { x: 1 - (2 * mx) / w, yTop: 1 - (2 * HEADER_PX) / h, yBottom: 1 - (2 * mb) / h, usable: true }
}

const scratch = new THREE.Vector3()

/** True when every point projects inside the limits. The camera must already have its matrices updated. */
export function fits(camera: THREE.PerspectiveCamera, points: THREE.Vector3[], lim: NdcLimits): boolean {
  const p = scratch
  for (const q of points) {
    p.copy(q).project(camera)
    if (p.z > 1 || Math.abs(p.x) > lim.x || p.y > lim.yTop || p.y < -lim.yBottom) return false
  }
  return true
}

/** Screen-space bounds (ndc) of the points as seen by the camera. Matrices must be current. */
export function ndcBounds(camera: THREE.PerspectiveCamera, points: THREE.Vector3[]) {
  const p = scratch
  const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
  for (const q of points) {
    p.copy(q).project(camera)
    b.minX = Math.min(b.minX, p.x); b.maxX = Math.max(b.maxX, p.x)
    b.minY = Math.min(b.minY, p.y); b.maxY = Math.max(b.maxY, p.y)
  }
  return b
}

/** Farthest the search will look. Past this the pane is so small or the valley so large that nothing sensible fits. */
const MAX_DISTANCE = 1e5

/**
 * Put the camera on the fixed viewing direction at the smallest distance where every point fits, then slide the target
 * across the ground so the creatures sit in the middle of the free area (between the header band and the bottom edge)
 * and refit. Smallest fitting distance means the creatures fill as much of the view as they can without touching an
 * edge. The search bound doubles until the points fit, so a crowded valley or a narrow pane is never left cropped, and
 * the far plane follows the chosen distance. `target` is updated in place; returns the distance used.
 */
export function fitCamera(camera: THREE.PerspectiveCamera, target: THREE.Vector3, points: THREE.Vector3[], w: number, h: number,
  dir = new THREE.Vector3(0.45, 0.5, 0.85), range: [number, number] = [8, 140]): number {
  const lim = ndcLimits(w, h)
  const d0 = dir.clone().normalize()
  const baseFar = Math.max(camera.far, 400)
  const place = (d: number) => {
    const far = Math.max(baseFar, d * 3) // the valley sits within a few creature-widths of the target; 3x leaves it all in front of the far plane
    if (camera.far !== far) { camera.far = far; camera.updateProjectionMatrix() }
    camera.position.copy(target).addScaledVector(d0, d)
    camera.lookAt(target)
    camera.updateMatrixWorld(true)
  }
  const solve = () => {
    let lo = range[0], hi = range[1]
    place(hi)
    while (!fits(camera, points, lim) && hi < MAX_DISTANCE) { lo = hi; hi *= 2; place(hi) }
    for (let i = 0; i < 28; i++) {
      const mid = (lo + hi) / 2
      place(mid)
      if (fits(camera, points, lim)) hi = mid; else lo = mid
    }
    place(hi)
    return hi
  }
  let d = solve()
  const right = new THREE.Vector3(d0.z, 0, -d0.x).normalize() // horizontal, to the camera's right
  const fwd = new THREE.Vector3(-d0.x, 0, -d0.z).normalize() // along the ground, away from the camera
  const sinEl = d0.y
  const halfV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)
  for (let i = 0; i < 16; i++) {
    const b = ndcBounds(camera, points)
    const cx = (b.minX + b.maxX) / 2
    const cy = (b.minY + b.maxY) / 2 - (lim.yTop - lim.yBottom) / 2 // where the content is minus where it should be
    if (Math.abs(cx) < 0.01 && Math.abs(cy) < 0.01) break
    target.addScaledVector(right, 0.8 * cx * d * halfV * camera.aspect)
    target.addScaledVector(fwd, (0.8 * cy * d * halfV) / sinEl)
    d = solve()
  }
  return d
}

/** Axis-aligned screen box, pixels. */
export interface Box { l: number; t: number; r: number; b: number }

export const overlaps = (a: Box, b: Box, pad = 0) => a.l < b.r + pad && b.l < a.r + pad && a.t < b.b + pad && b.t < a.b + pad

export interface LabelIn {
  /** screen position of the label anchor, pixels */
  x: number
  y: number
  /** estimated text width, pixels */
  width: number
  /** distance from the camera */
  dist: number
  /** labels of the hovered or selected project are never dropped for being crowded */
  pinned: boolean
}
export interface LabelOut { show: boolean; opacity: number; x: number; y: number }

export const LABEL_H = 15
/** Label text sits above its anchor (translate -50%, -120%). */
export function labelBox(x: number, y: number, width: number): Box {
  return { l: x - width / 2, r: x + width / 2, t: y - LABEL_H * 1.2, b: y - LABEL_H * 0.2 }
}

/** Reusable box, written in place (see `LabelPlacer`). */
function setBox(b: Box, x: number, y: number, width: number) {
  b.l = x - width / 2; b.r = x + width / 2; b.t = y - LABEL_H * 1.2; b.b = y - LABEL_H * 0.2
}

/**
 * Decides which labels draw. A label is dropped when it would sit in the header band or off the pane, over a climber ring
 * (`addAvoid`, screen boxes), or over a label already placed. Pinned labels go first, then nearer ones. Opacity fades with
 * distance so far labels recede instead of competing with near ones.
 *
 * It runs every animation frame, so it owns its storage: input and output records, the placed boxes and the draw order are
 * pooled and rewritten in place, and the order is kept between frames and repaired by insertion sort (the order barely
 * changes from one frame to the next, so that costs about one pass). A frame allocates nothing once the pools have grown to
 * the largest scene seen.
 */
export class LabelPlacer {
  /** labels added since `begin()`; `out[0..count)` holds their results, in the order they were added */
  count = 0
  readonly out: LabelOut[] = []
  private ins: LabelIn[] = []
  private avoid: Box[] = []
  private nAvoid = 0
  private placed: Box[] = []
  private nPlaced = 0
  private order: number[] = []
  private box: Box = { l: 0, t: 0, r: 0, b: 0 }

  begin() { this.count = 0; this.nAvoid = 0 }

  add(x: number, y: number, width: number, dist: number, pinned: boolean): number {
    const i = this.count++
    let r = this.ins[i]
    if (!r) { r = this.ins[i] = { x, y, width, dist, pinned }; this.out[i] = { show: false, opacity: 0, x, y } } else { r.x = x; r.y = y; r.width = width; r.dist = dist; r.pinned = pinned }
    return i
  }

  addAvoid(l: number, t: number, r: number, b: number) {
    const a = this.avoid[this.nAvoid++]
    if (a) { a.l = l; a.t = t; a.r = r; a.b = b } else this.avoid[this.nAvoid - 1] = { l, t, r, b }
  }

  /** `a` draws before `b`: pinned first, then nearer */
  private before(a: number, b: number): boolean {
    const x = this.ins[a], y = this.ins[b]
    return x.pinned !== y.pinned ? x.pinned : x.dist < y.dist
  }

  place(w: number, h: number, fadeFrom = 45, fadeTo = 80): void {
    const n = this.count
    const order = this.order
    if (order.length !== n) { order.length = n; for (let i = 0; i < n; i++) order[i] = i }
    for (let i = 1; i < n; i++) { // insertion sort, stable, on last frame's order
      const v = order[i]
      let j = i - 1
      while (j >= 0 && this.before(v, order[j])) { order[j + 1] = order[j]; j-- }
      order[j + 1] = v
    }
    this.nPlaced = 0
    for (let i = 0; i < n; i++) { const o = this.out[i]; o.show = false; o.opacity = 0; o.x = this.ins[i].x; o.y = this.ins[i].y }
    const box = this.box
    for (let k = 0; k < n; k++) {
      const i = order[k]
      const l = this.ins[i]
      // a label whose anchor is inside the pane slides sideways to stay readable instead of being cut at the edge
      const x = l.x < 0 || l.x > w ? l.x : Math.min(Math.max(l.x, 4 + l.width / 2), w - 4 - l.width / 2)
      setBox(box, x, l.y, l.width)
      if (box.t < HEADER_PX || box.l < 4 || box.r > w - 4 || box.b > h - 4) continue
      const fade = l.pinned ? 1 : Math.min(1, Math.max(0, (fadeTo - l.dist) / (fadeTo - fadeFrom)))
      if (fade <= 0.05) continue
      let hit = false
      for (let a = 0; a < this.nAvoid && !hit; a++) hit = overlaps(box, this.avoid[a], 2)
      for (let a = 0; a < this.nPlaced && !hit; a++) hit = overlaps(box, this.placed[a], 4)
      if (hit) continue
      const slot = this.placed[this.nPlaced] ?? (this.placed[this.nPlaced] = { l: 0, t: 0, r: 0, b: 0 })
      this.nPlaced++
      slot.l = box.l; slot.t = box.t; slot.r = box.r; slot.b = box.b
      const o = this.out[i]
      o.show = true; o.opacity = 0.92 * fade; o.x = x
    }
  }
}

/** One-shot form of `LabelPlacer` for callers that hold their labels as arrays (tests, tools). */
export function placeLabels(labels: LabelIn[], avoid: Box[], w: number, h: number, fadeFrom = 45, fadeTo = 80): LabelOut[] {
  const pl = new LabelPlacer()
  pl.begin()
  for (const l of labels) pl.add(l.x, l.y, l.width, l.dist, l.pinned)
  for (const a of avoid) pl.addAvoid(a.l, a.t, a.r, a.b)
  pl.place(w, h, fadeFrom, fadeTo)
  return pl.out.slice(0, pl.count).map((o) => ({ ...o }))
}
