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

/** Largest |ndc| the framed points may reach on each axis for a pane of w x h pixels (top is reserved for the header). */
export function ndcLimits(w: number, h: number): { x: number; yTop: number; yBottom: number } {
  const x = Math.max(0.5, 1 - (2 * EDGE_PX) / w)
  const yTop = Math.max(0.4, 1 - (2 * HEADER_PX) / h)
  const yBottom = Math.max(0.5, 1 - (2 * EDGE_PX) / h)
  return { x, yTop, yBottom }
}

/** True when every point projects inside the limits. The camera must already have its matrices updated. */
export function fits(camera: THREE.PerspectiveCamera, points: THREE.Vector3[], lim: { x: number; yTop: number; yBottom: number }): boolean {
  const p = new THREE.Vector3()
  for (const q of points) {
    p.copy(q).project(camera)
    if (p.z > 1 || Math.abs(p.x) > lim.x || p.y > lim.yTop || p.y < -lim.yBottom) return false
  }
  return true
}

/** Screen-space bounds (ndc) of the points as seen by the camera. Matrices must be current. */
export function ndcBounds(camera: THREE.PerspectiveCamera, points: THREE.Vector3[]) {
  const p = new THREE.Vector3()
  const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
  for (const q of points) {
    p.copy(q).project(camera)
    b.minX = Math.min(b.minX, p.x); b.maxX = Math.max(b.maxX, p.x)
    b.minY = Math.min(b.minY, p.y); b.maxY = Math.max(b.maxY, p.y)
  }
  return b
}

/**
 * Put the camera on the fixed viewing direction at the smallest distance where every point fits, then slide the target
 * across the ground so the creatures sit in the middle of the free area (between the header band and the bottom edge)
 * and refit. Smallest fitting distance means the creatures fill as much of the view as they can without touching an
 * edge. `target` is updated in place; returns the distance used.
 */
export function fitCamera(camera: THREE.PerspectiveCamera, target: THREE.Vector3, points: THREE.Vector3[], w: number, h: number,
  dir = new THREE.Vector3(0.45, 0.5, 0.85), range: [number, number] = [8, 140]): number {
  const lim = ndcLimits(w, h)
  const d0 = dir.clone().normalize()
  const place = (d: number) => {
    camera.position.copy(target).addScaledVector(d0, d)
    camera.lookAt(target)
    camera.updateMatrixWorld(true)
  }
  const solve = () => {
    let lo = range[0], hi = range[1]
    place(hi)
    if (!fits(camera, points, lim)) return hi // never happens for a real valley; keep the farthest view rather than loop
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

/**
 * Decide which labels draw. A label is dropped when it would sit in the header band or off the pane, over a climber ring
 * (`avoid`, screen boxes), or over a label already placed. Pinned labels go first, then nearer ones. Opacity fades with
 * distance so far labels recede instead of competing with near ones.
 */
export function placeLabels(labels: LabelIn[], avoid: Box[], w: number, h: number, fadeFrom = 45, fadeTo = 80): LabelOut[] {
  const out: LabelOut[] = labels.map((l) => ({ show: false, opacity: 0, x: l.x, y: l.y }))
  const order = labels.map((_, i) => i).sort((a, b) => Number(labels[b].pinned) - Number(labels[a].pinned) || labels[a].dist - labels[b].dist)
  const placed: Box[] = []
  for (const i of order) {
    const l = labels[i]
    // a label whose anchor is inside the pane slides sideways to stay readable instead of being cut at the edge
    const x = l.x < 0 || l.x > w ? l.x : Math.min(Math.max(l.x, 4 + l.width / 2), w - 4 - l.width / 2)
    const box = labelBox(x, l.y, l.width)
    if (box.t < HEADER_PX || box.l < 4 || box.r > w - 4 || box.b > h - 4) continue
    const fade = l.pinned ? 1 : Math.min(1, Math.max(0, (fadeTo - l.dist) / (fadeTo - fadeFrom)))
    if (fade <= 0.05) continue
    if (avoid.some((a) => overlaps(box, a, 2))) continue
    if (placed.some((p) => overlaps(box, p, 4))) continue
    placed.push(box)
    out[i] = { show: true, opacity: 0.92 * fade, x, y: l.y }
  }
  return out
}
