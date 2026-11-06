// three.js scene: valley, creatures (torso + lofted limbs + instanced scales + carvings), climbers, orbit camera, picking.
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { buildCreature, frameAt, layoutCreatures, type CreatureSpec, type LimbSpec, type Material, type V3 } from './creature'
import { hashString, rng } from './rng'
import { creaturePoints, fitCamera, LabelPlacer, setDepthRange } from './framing'
import { claimedWithoutClimber } from './reducer'
import { dropOutcome, isDrag, type AssignRequest } from './drag'
import { slipPose } from './slip'
import { knownStatus, pulse, SCALE_K, STATUS_LOOK } from './status-look'
import type { Card, Project, Snapshot, Worker } from './types'

export const STATUS_COLOR: Record<Card['status'], number> = {
  open: 0xd8d0b4, // bone
  running: 0xf2b134, // amber
  blocked: 0xff5436, // ember: the glowing one
  review: 0x8c9cff, // dusk blue
  done: 0x73876a, // moss stone
  unknown: 0x7d7d7d, // grey
}
export const WORKER_COLOR: Record<Worker['state'], number> = {
  working: 0xffd36a, waiting_human: 0x6fd3ff, looping: 0xff6fa8, idle: 0xb9b2a0, unknown: 0xa6a6a6,
}
export const MATERIAL_COLOR: Record<Material, number> = { stone: 0xc2bcac, lichen: 0xa6c74c, coral: 0xa8809a } // dusty mauve: a limb must never share the blocked ember hue (0xff5436) or it reads as a blocked card

export type Pick =
  | { kind: 'card'; id: string }
  | { kind: 'doc'; cardId: string; path: string; title: string }
  | { kind: 'worker'; id: string }
  | { kind: 'project'; id: string }

export interface SceneCallbacks {
  onPick(p: Pick | null): void
  onHover(label: string | null, x: number, y: number): void
  /** A climber was dropped on a scale. The pane opens the card's profile selector; nothing is claimed or assigned. */
  onDrop?(req: AssignRequest): void
}

/** Scales are drawn only when a creature is close enough, once the valley is crowded (legibility past ~100 cards). */
export const CROWDED = 100
/** Height of the pin above a selected scale, in world units. */
const SELECT_PIN = 2.4
export function showScales(totalCards: number, dist: number, radius: number): boolean {
  return totalCards <= CROWDED || dist < 7 + radius * 1.7
}

/** One limb label. The cache fields let a frame skip text and style writes when nothing changed (see positionLabels). */
interface LabelView {
  el: HTMLElement; world: THREE.Vector3; limb: LimbSpec
  textKey: number; width: number // text is rebuilt only when this key changes (-1 = plain title, n = title with a count)
  shown: boolean | null; sx: number; sy: number; so: number // what the element currently shows
}

interface CreatureView {
  spec: CreatureSpec
  key: string
  group: THREE.Group
  center: THREE.Vector3
  scales: THREE.InstancedMesh
  claims: THREE.InstancedMesh // ring over each scale whose card is claimed by a worker that is not climbing it
  halo: THREE.InstancedMesh // additive glow around each scale whose status asks for one (blocked)
  scalePose: { pos: THREE.Vector3; q: THREE.Quaternion; nrm: THREE.Vector3; k: number }[]
  scaleIds: string[]
  scaleBase: THREE.Matrix4[]
  bands: THREE.Group // aggregate status bands per limb (zoomed-out view)
  carvingMeshes: THREE.InstancedMesh[]
  carvingInfo: { cardId: string; path: string; title: string }[][]
  torso: THREE.Mesh
  labels: LabelView[]
  cardPos: Map<string, THREE.Vector3> // world position of each card's scale
  limbOf: Map<string, LimbSpec>
}

interface ClimberView {
  id: string
  mesh: THREE.Group
  body: THREE.Mesh
  ring: THREE.Mesh
  pos: THREE.Vector3
  target: THREE.Vector3
  home: THREE.Vector3
  hop: number
  phase: number
  worker: Worker
  cardId: string | null
}

export class FoundryScene {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(48, 1, 0.1, 400)
  readonly controls: OrbitControls
  private raycaster = new THREE.Raycaster()
  private creatures = new Map<string, CreatureView>()
  private climbers = new Map<string, ClimberView>()
  private beacons: { mesh: THREE.Mesh; cardId: string }[] = []
  // Selection marker: a ring round the scale, a pin above it and (in the DOM) a label with the card's title and status.
  // Both meshes ignore depth so a scale behind a limb is still found.
  private selection = new THREE.Mesh(new THREE.TorusGeometry(1, 0.1, 8, 28), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }))
  private selectionPin = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }))
  private selectionLabel: HTMLElement | null = null
  private selectionText = ''
  private raf = 0
  private clock = new THREE.Clock()
  /** shared by every scale material: drives the pulse of a blocked glow */
  private glowTime = { value: 0 }
  private snap: Snapshot | null = null
  private totalCards = 0
  private selectedCard: string | null = null
  private focus: { fromT: THREE.Vector3; toT: THREE.Vector3; fromP: THREE.Vector3; toP: THREE.Vector3; t: number } | null = null
  /** The creature the camera last approached, while the user has not orbited away: a resize re-fits it. */
  private focusedId: string | null = null
  /** The press in flight. Only the pointer that started it can finish it; `multi` marks a second pointer joining. */
  private down: { x: number; y: number; id: number; multi: boolean } | null = null
  /** The climber being dragged, if the press started on one. Orbit is suspended while it is set. `cancelled` is final:
   *  once the pointer has left the canvas the gesture can no longer drop, even if it comes back. */
  private drag: { workerId: string; id: number; cancelled: boolean } | null = null
  private dropSeq = 0
  private labelHost: HTMLElement
  private disposed = false
  private hoverQueued = false
  private lastPointer = { x: 0, y: 0 }
  /** time source, replaceable in tests/screenshots */
  frameCount = 0

  constructor(private canvas: HTMLCanvasElement, labelHost: HTMLElement, private cb: SceneCallbacks) {
    this.labelHost = labelHost
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2))
    this.renderer.shadowMap.enabled = false
    this.scene.background = new THREE.Color(0x0c1210)
    this.scene.fog = new THREE.FogExp2(0x0c1210, 0.015)
    this.scene.add(new THREE.HemisphereLight(0xa9c4cc, 0x120e0a, 0.8))
    const sun = new THREE.DirectionalLight(0xffd9a6, 3.0)
    sun.position.set(30, 45, 20)
    this.scene.add(sun)
    this.buildValley()
    this.selection.visible = false
    this.selection.rotation.x = Math.PI / 2
    this.selection.renderOrder = 10
    this.selectionPin.visible = false
    this.selectionPin.renderOrder = 10
    this.scene.add(this.selection, this.selectionPin)

    this.camera.position.set(0, 20, 30)
    // Our pointer listeners go on first. OrbitControls registers its own after, so a press that starts on a climber can
    // be stopped here (stopImmediatePropagation) before OrbitControls sees it or captures the pointer. Order matters.
    canvas.addEventListener('pointerdown', this.onDown)
    canvas.addEventListener('pointerup', this.onUp)
    canvas.addEventListener('pointermove', this.onMove)
    canvas.addEventListener('pointerleave', this.onLeave)
    canvas.addEventListener('pointercancel', this.onCancel)
    canvas.addEventListener('dblclick', this.onDbl)
    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enablePan = false // orbit and zoom only
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.minDistance = 4
    this.controls.maxDistance = 70
    this.controls.maxPolarAngle = Math.PI * 0.47
    this.controls.addEventListener('start', () => { this.userMoved = true; this.focusedId = null; this.focus = null }) // from here the user owns the view
    this.controls.target.set(0, 3, 0)
    this.loop()
  }

  // ---------------- valley ----------------
  private buildValley() {
    const size = 140, seg = 96
    const g = new THREE.PlaneGeometry(size, size, seg, seg)
    g.rotateX(-Math.PI / 2)
    const pos = g.attributes.position as THREE.BufferAttribute
    const col = new Float32Array(pos.count * 3)
    const r = rng(7)
    const ph = [r() * 6, r() * 6, r() * 6]
    const c = new THREE.Color()
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i)
      const d = Math.hypot(x, z)
      const bowl = Math.min(1, d / 55)
      const h = bowl * bowl * 22 + Math.sin(x * 0.11 + ph[0]) * 1.1 + Math.cos(z * 0.13 + ph[1]) * 1.0 + Math.sin((x + z) * 0.31 + ph[2]) * 0.35
      pos.setY(i, h - 1.2)
      const t = Math.min(1, Math.max(0, h / 14))
      c.setHex(0x3a4a2d).lerp(new THREE.Color(0x4d4c46), t) // lichen floor to bare stone on the rim
      const n = (Math.sin(x * 1.7) * Math.cos(z * 1.9) + 1) * 0.04
      col[i * 3] = c.r * (0.9 + n); col[i * 3 + 1] = c.g * (0.9 + n); col[i * 3 + 2] = c.b * (0.9 + n)
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3))
    g.computeVertexNormals()
    const ground = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 }))
    this.scene.add(ground)
    // scattered boulders and coral-like tufts
    const rr = rng(99)
    const rockGeo = new THREE.IcosahedronGeometry(1, 0)
    const rocks = new THREE.InstancedMesh(rockGeo, new THREE.MeshStandardMaterial({ color: 0x3b3a36, flatShading: true, roughness: 1 }), 70)
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler()
    for (let i = 0; i < 70; i++) {
      const a = rr() * 6.283, d = 14 + rr() * 38
      const s = 0.4 + rr() * 1.6
      e.set(rr() * 3, rr() * 3, rr() * 3); q.setFromEuler(e)
      m.compose(new THREE.Vector3(Math.cos(a) * d, -0.6, Math.sin(a) * d), q, new THREE.Vector3(s, s * 0.7, s))
      rocks.setMatrixAt(i, m)
    }
    this.scene.add(rocks)
  }

  // ---------------- data ----------------
  update(snap: Snapshot) {
    if (this.disposed) return
    this.snap = snap
    this.totalCards = snap.projects.reduce((n, p) => n + p.cards.length, 0)
    const specs = snap.projects.map(buildCreature)
    const spots = layoutCreatures(specs)
    const seen = new Set<string>()
    specs.forEach((spec, i) => {
      seen.add(spec.projectId)
      const proj = snap.projects[i]
      // Everything the cached spec (labels, aggregate bands, tooltips, carvings) is derived from.
      const key = creatureKey(proj)
      let v = this.creatures.get(spec.projectId)
      if (!v || v.key !== key) {
        if (v) this.disposeCreature(v)
        v = this.makeCreature(spec, key, new THREE.Vector3(...spots[i]))
        this.creatures.set(spec.projectId, v)
      }
      moveCreature(v, new THREE.Vector3(...spots[i]))
      this.recolor(v, proj.cards, snap.workers)
    })
    for (const [id, v] of this.creatures) if (!seen.has(id)) { this.disposeCreature(v); this.creatures.delete(id) }
    if (this.hoverProject && !this.creatures.has(this.hoverProject)) this.hoverProject = null // the hovered project is gone
    this.updateBeacons(snap)
    this.updateClimbers(snap)
    if (this.selectedCard) this.select(this.selectedCard)
    // Creatures added, removed, rebuilt or moved change what the frame must hold. Reframe for that while the user has
    // not taken the camera; once they have, the view stays theirs.
    const sig = this.layoutSignature()
    if (sig !== this.frameSig && !this.userMoved) this.frameValley(true)
    else this.frameValley(false)
  }

  /** What the framing depends on: which creatures exist, their shape key and where they stand. */
  private frameSig = ''
  private layoutSignature(): string {
    let s = ''
    for (const [id, v] of this.creatures) s += `${id}|${v.key}|${v.center.x.toFixed(2)},${v.center.z.toFixed(2)};`
    return s
  }

  /**
   * Frame the whole valley: every creature's footprint and crown inside the pane (clear of the header and the edges),
   * at the closest distance where that holds so the creatures fill the view. Runs on first data and on every resize
   * until the user moves the camera, so a different pane size never leaves creatures cropped.
   */
  private framed = false
  private userMoved = false
  private viewW = 0
  private viewH = 0
  private frameDist = 50
  private frameGeo: { sig: string; pts: THREE.Vector3[]; mid: THREE.Vector3 } | null = null
  frameValley(force: boolean) {
    if (this.framed && !force) return
    if (this.creatures.size === 0 || this.viewW < 2) return
    this.framed = true
    this.frameSig = this.layoutSignature()
    // the points and their centre depend on the creatures, not the pane size: keep them between resizes
    if (this.frameGeo?.sig !== this.frameSig) {
      const pts: THREE.Vector3[] = []
      for (const v of this.creatures.values()) pts.push(...creaturePoints(v.center, v.spec))
      this.frameGeo = { sig: this.frameSig, pts, mid: new THREE.Box3().setFromPoints(pts).getCenter(new THREE.Vector3()) }
    }
    const { pts, mid } = this.frameGeo
    this.controls.target.set(mid.x, 0, mid.z)
    this.frameDist = fitCamera(this.camera, this.controls.target, pts, this.viewW, this.viewH)
    this.controls.maxDistance = Math.max(70, this.frameDist * 1.3)
    // keep the fog's grip on the creatures constant when a large or tall valley pushes the camera back
    if (this.scene.fog instanceof THREE.FogExp2) this.scene.fog.density = Math.min(0.015, 0.55 / this.frameDist)
    this.controls.update()
  }

  /**
   * Fly to a creature: the destination is the camera distance and target that fit the creature's real extent into the free
   * part of the pane (clear of the header and the edges), looking from the direction the user already has. Both the target
   * and the camera move, so the creature ends up centred and uncropped at any pane size.
   */
  focusCreature(projectId: string) {
    const v = this.creatures.get(projectId)
    if (!v) return
    this.userMoved = true
    this.focusedId = projectId
    const dest = this.fitCreature(v)
    if (!dest) return
    this.focus = { fromT: this.controls.target.clone(), toT: dest.target, fromP: this.camera.position.clone(), toP: dest.pos, t: 0 }
  }

  /** Where the camera and target must be to frame one creature in the pane. The camera is left where it was. */
  private fitCreature(v: CreatureView): { target: THREE.Vector3; pos: THREE.Vector3 } | null {
    if (this.viewW < 2) return null
    const keepP = this.camera.position.clone(), keepT = this.controls.target.clone()
    const dir = keepP.clone().sub(keepT)
    if (dir.lengthSq() < 1e-6) dir.set(0.45, 0.5, 0.85)
    dir.normalize()
    dir.y = Math.min(Math.max(dir.y, 0.25), 0.9) // from above the ground at a readable angle, whatever the user orbited to
    const target = new THREE.Vector3(v.center.x, 0, v.center.z)
    fitCamera(this.camera, target, creaturePoints(v.center, v.spec), this.viewW, this.viewH, dir, [4, 140])
    const out = { target: target.clone(), pos: this.camera.position.clone() }
    this.camera.position.copy(keepP)
    this.controls.target.copy(keepT)
    this.camera.lookAt(keepT)
    this.camera.updateMatrixWorld(true)
    return out
  }

  private makeCreature(spec: CreatureSpec, key: string, center: THREE.Vector3): CreatureView {
    const group = new THREE.Group()
    group.position.copy(center)
    this.scene.add(group)
    // torso: a few merged lumps
    const tm = new THREE.MeshStandardMaterial({ color: MATERIAL_COLOR[spec.torso.material], flatShading: true, roughness: 0.95 })
    const tg = new THREE.IcosahedronGeometry(1, 2)
    jitter(tg, spec.seed, 0.12)
    const torso = new THREE.Mesh(tg, tm)
    torso.scale.set(...spec.torso.radii)
    torso.position.y = spec.torso.radii[1] * 0.5
    torso.userData = { project: spec.projectId }
    group.add(torso)
    for (const l of spec.torso.lumps) {
      const lg = new THREE.IcosahedronGeometry(l.r, 1)
      jitter(lg, spec.seed ^ 7, 0.1)
      const lm = new THREE.Mesh(lg, tm)
      lm.position.set(l.pos[0], l.pos[1] + spec.torso.radii[1] * 0.5, l.pos[2])
      lm.userData = { project: spec.projectId }
      group.add(lm)
    }
    const lift = spec.torso.radii[1] * 0.5
    const labels: CreatureView['labels'] = []
    const cardPos = new Map<string, THREE.Vector3>()
    const limbOf = new Map<string, LimbSpec>()
    const bands = new THREE.Group()
    group.add(bands)
    const allScales = spec.limbs.flatMap((l) => l.scales)
    const scaleGeo = new THREE.CylinderGeometry(0.5, 0.42, 0.22, 6)
    scaleGeo.translate(0, 0.08, 0)
    // per-scale glow and stone-ness ride on instanced attributes; the material lights itself with its own colour
    const nScale = Math.max(allScales.length, 1)
    const aGlow = new THREE.InstancedBufferAttribute(new Float32Array(nScale), 1)
    const aStone = new THREE.InstancedBufferAttribute(new Float32Array(nScale), 1)
    scaleGeo.setAttribute('aGlow', aGlow)
    scaleGeo.setAttribute('aStone', aStone)
    const scaleMat = this.statusMaterial()
    const scales = new THREE.InstancedMesh(scaleGeo, scaleMat, nScale)
    scales.count = allScales.length
    const scaleBase: THREE.Matrix4[] = []
    const scalePose: CreatureView['scalePose'] = []
    const scaleIds: string[] = []
    const up = new THREE.Vector3(0, 1, 0)
    const q = new THREE.Quaternion()
    const m = new THREE.Matrix4()
    let si = 0
    for (const limb of spec.limbs) {
      const geo = loft(limb.path, limb.radii, spec.seed ^ hashString(limb.title))
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: MATERIAL_COLOR[limb.material], flatShading: true, roughness: 0.95 }))
      mesh.position.y = lift
      mesh.userData = { project: spec.projectId }
      group.add(mesh)
      // label at the limb tip
      const tip = limb.path[limb.path.length - 1]
      const el = document.createElement('div')
      el.className = 'foundry-label'
      el.textContent = `${limb.title}`
      el.style.cssText = 'position:absolute;pointer-events:none;font:11px var(--dt-font-sans,system-ui);color:#eef2e6;text-shadow:0 1px 3px #000;white-space:nowrap;transform:translate(-50%,-120%);opacity:0.92'
      this.labelHost.appendChild(el)
      labels.push({ el, world: new THREE.Vector3(tip[0], tip[1] + lift + limb.radii.at(-1)! + 0.5, tip[2]).add(center), limb, textKey: -2, width: 0, shown: null, sx: NaN, sy: NaN, so: NaN })
      // aggregate band: one thin loft per status over the limb, proportional to counts
      let t0 = 0.06
      const total = limb.scales.length || 1
      for (const st of ['done', 'review', 'running', 'blocked', 'open', 'unknown'] as Card['status'][]) {
        const n = limb.counts[st]
        if (!n) continue
        const t1 = Math.min(t0 + (n / total) * 0.9, 0.98)
        const sub = subPath(limb.path, limb.radii, t0, t1)
        if (sub) {
          const b = new THREE.Mesh(loft(sub.path, sub.radii.map((r) => r * 1.12 + 0.05), 1, 8), new THREE.MeshStandardMaterial({ color: STATUS_COLOR[st], flatShading: true, roughness: 0.5 }))
          b.position.y = lift
          bands.add(b)
        }
        t0 = t1
      }
      for (const s of limb.scales) {
        limbOf.set(s.cardId, limb)
        const nrm = new THREE.Vector3(...s.normal)
        q.setFromUnitVectors(up, nrm)
        const k = s.size * SCALE_K
        const pos = new THREE.Vector3(s.pos[0], s.pos[1] + lift, s.pos[2])
        m.compose(pos, q, new THREE.Vector3(k, k, k))
        scales.setMatrixAt(si, m) // recolor() re-poses it for the card's status
        scaleBase.push(m.clone())
        scalePose.push({ pos, q: q.clone(), nrm: nrm.clone(), k })
        scaleIds.push(s.cardId)
        cardPos.set(s.cardId, pos.clone().add(center).add(nrm.clone().multiplyScalar(s.size * 0.5)))
        si++
      }
    }
    scales.userData = { kind: 'scales', project: spec.projectId }
    group.add(scales)
    // claim rings: one slot per scale, shown only for a claim without a climber on the card
    const ringGeo = new THREE.TorusGeometry(0.62, 0.07, 6, 16)
    ringGeo.rotateX(Math.PI / 2)
    ringGeo.translate(0, 0.2, 0)
    const claims = new THREE.InstancedMesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xf2c14e }), Math.max(allScales.length, 1))
    claims.count = allScales.length
    claims.userData = { kind: 'claims', project: spec.projectId }
    claims.raycast = () => {} // a marker, not a pick target: clicks fall through to the scale
    group.add(claims)
    // halo: a soft additive bubble around each blocked scale, pulsing, so blocked glows from far away
    const haloGeo = new THREE.IcosahedronGeometry(1, 1)
    const haloMat = new THREE.MeshBasicMaterial({ color: STATUS_COLOR.blocked, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false })
    const halo = new THREE.InstancedMesh(haloGeo, haloMat, nScale)
    halo.count = allScales.length
    halo.userData = { kind: 'halo', project: spec.projectId }
    halo.raycast = () => {} // not a pick target: clicks fall through to the scale
    halo.renderOrder = 2
    group.add(halo)
    // carvings: three glyph shapes, instanced, darker inset into the limb
    const glyphGeos = [new THREE.TorusGeometry(0.5, 0.12, 5, 10), new THREE.BoxGeometry(0.9, 0.16, 0.16), new THREE.OctahedronGeometry(0.5)]
    const carvingMeshes: THREE.InstancedMesh[] = []
    const carvingInfo: CreatureView['carvingInfo'] = []
    const buckets: { c: LimbSpec['carvings'][number] }[][] = [[], [], []]
    for (const l of spec.limbs) for (const c of l.carvings) buckets[c.glyph % 3].push({ c })
    buckets.forEach((list, gi) => {
      const im = new THREE.InstancedMesh(glyphGeos[gi], new THREE.MeshStandardMaterial({ color: 0x2b2a26, flatShading: true, roughness: 1 }), Math.max(list.length, 1))
      im.count = list.length
      const info: CreatureView['carvingInfo'][number] = []
      list.forEach(({ c }, i) => {
        const nrm = new THREE.Vector3(...c.normal)
        q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), nrm)
        m.compose(new THREE.Vector3(c.pos[0], c.pos[1] + lift, c.pos[2]), q, new THREE.Vector3(c.size, c.size, c.size))
        im.setMatrixAt(i, m)
        info.push({ cardId: c.cardId, path: c.docPath, title: c.title })
      })
      im.userData = { kind: 'carving', index: gi, project: spec.projectId }
      group.add(im)
      carvingMeshes.push(im); carvingInfo.push(info)
    })
    return { spec, key, group, center, scales, claims, halo, scalePose, scaleIds, scaleBase, bands, carvingMeshes, carvingInfo, torso, labels, cardPos, limbOf }
  }

  /** Scale material: standard lighting plus per-instance self-light (aGlow) and weathering (aStone). */
  private statusMaterial(): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.6, flatShading: true })
    const time = this.glowTime
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = time
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aGlow;\nattribute float aStone;\nvarying float vGlow;\nvarying float vStone;\nvarying vec3 vLocal;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;\nvStone = aStone;\nvLocal = position;')
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying float vGlow;\nvarying float vStone;\nvarying vec3 vLocal;')
        .replace('#include <color_fragment>', `#include <color_fragment>
        if (vStone > 0.0) {
          // weather to stone: grey the colour, darken it, speckle it (speckle is fixed to the hex, so it does not shimmer)
          float sp = fract(sin(dot(floor(vLocal * 7.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
          vec3 grey = vec3(dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11)));
          diffuseColor.rgb = mix(diffuseColor.rgb, grey * vec3(0.96, 0.97, 1.0), vStone * 0.55) * (1.0 - vStone * (0.12 + 0.3 * sp));
        }`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (vGlow > 0.0) {
          float g = vGlow;
          if (g > 1.0) g *= 1.0 + 0.2 * sin(uTime * 2.6);
          totalEmissiveRadiance += diffuseColor.rgb * g;
        }`)
    }
    mat.customProgramCacheKey = () => 'foundry-status-scale'
    return mat
  }

  private recolor(v: CreatureView, cards: Card[], workers: Worker[]) {
    const byId = new Map(cards.map((c) => [c.id, c]))
    const col = new THREE.Color()
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0)
    const m = new THREE.Matrix4()
    const sc = new THREE.Vector3()
    const at = new THREE.Vector3()
    const aGlow = v.scales.geometry.getAttribute('aGlow') as THREE.BufferAttribute
    const aStone = v.scales.geometry.getAttribute('aStone') as THREE.BufferAttribute
    v.scaleIds.forEach((id, i) => {
      const c = byId.get(id)
      const st = knownStatus(c?.status)
      const look = STATUS_LOOK[st]
      const pose = v.scalePose[i]
      col.setHex(STATUS_COLOR[st])
      v.scales.setColorAt(i, col)
      aGlow.setX(i, look.glow)
      aStone.setX(i, look.stone)
      // status sets the size: wide and tall for the loud ones, low and flat for done
      v.scales.setMatrixAt(i, m.compose(pose.pos, pose.q, sc.set(pose.k * look.w, pose.k * look.h, pose.k * look.w)))
      // claim ring rides on top of whatever the scale is
      const ringK = pose.k * look.w
      at.copy(pose.pos).addScaledVector(pose.nrm, Math.max(0, 0.19 * pose.k * look.h - 0.19 * ringK))
      v.claims.setMatrixAt(i, c && claimedWithoutClimber(c, workers) ? m.compose(at, pose.q, sc.set(ringK, ringK, ringK)) : hidden)
      // halo: only for statuses that glow wide, sat just off the limb under the scale
      at.copy(pose.pos).addScaledVector(pose.nrm, 0.2 * pose.k * look.h)
      v.halo.setMatrixAt(i, look.halo ? m.compose(at, pose.q, sc.setScalar(pose.k * 1.25)) : hidden)
    })
    if (v.scales.instanceColor) v.scales.instanceColor.needsUpdate = true
    v.scales.instanceMatrix.needsUpdate = true
    aGlow.needsUpdate = true
    aStone.needsUpdate = true
    v.claims.instanceMatrix.needsUpdate = true
    v.halo.instanceMatrix.needsUpdate = true
  }

  private disposeCreature(v: CreatureView) {
    this.scene.remove(v.group)
    disposeTree(v.group)
    v.labels.forEach((l) => l.el.remove())
  }

  private updateBeacons(snap: Snapshot) {
    for (const b of this.beacons) { this.scene.remove(b.mesh); disposeTree(b.mesh) }
    this.beacons = []
    for (const p of snap.projects) for (const c of p.cards) {
      if (c.blocked_on !== 'human') continue
      const pos = this.cardWorldPos(c.id)
      if (!pos) continue
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 8), new THREE.MeshBasicMaterial({ color: 0x6fd3ff, transparent: true, opacity: 0.85 }))
      mesh.position.copy(pos).add(new THREE.Vector3(0, 1.0, 0))
      this.scene.add(mesh)
      this.beacons.push({ mesh, cardId: c.id })
    }
  }

  cardWorldPos(cardId: string): THREE.Vector3 | null {
    for (const v of this.creatures.values()) { const p = v.cardPos.get(cardId); if (p) return p }
    return null
  }

  // ---------------- climbers ----------------
  private updateClimbers(snap: Snapshot) {
    const live = new Set<string>()
    const ids = [...this.creatures.keys()].sort()
    for (const w of snap.workers) {
      live.add(w.id)
      let c = this.climbers.get(w.id)
      if (!c) {
        const g = new THREE.Group()
        const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.34, 4, 8), new THREE.MeshStandardMaterial({ roughness: 0.4, emissiveIntensity: 0.5 }))
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), new THREE.MeshStandardMaterial({ color: 0xf1ead8, roughness: 0.6 }))
        head.position.y = 0.46
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.04, 6, 24), new THREE.MeshBasicMaterial({ color: 0x6fd3ff, transparent: true, opacity: 0.8 }))
        ring.rotation.x = Math.PI / 2; ring.position.y = 0.2
        g.add(body, head, ring)
        g.userData = { kind: 'worker', id: w.id }
        body.userData = head.userData = ring.userData = g.userData
        this.scene.add(g)
        const home = new THREE.Vector3()
        c = { id: w.id, mesh: g, body, ring, pos: new THREE.Vector3(), target: new THREE.Vector3(), home, hop: 0, phase: (hashString(w.id) % 628) / 100, worker: w, cardId: null }
        this.climbers.set(w.id, c)
        this.placeAtHome(c, ids)
        c.pos.copy(c.home)
      }
      c.worker = w
      c.cardId = w.card_id
      this.placeAtHome(c, ids)
      const tgt = w.card_id ? this.cardWorldPos(w.card_id) : null
      const want = tgt ?? c.home
      if (c.target.distanceToSquared(want) > 0.01) { c.hop = 1; c.target.copy(want) }
      const mat = c.body.material as THREE.MeshStandardMaterial
      mat.color.setHex(WORKER_COLOR[w.state]); mat.emissive.setHex(WORKER_COLOR[w.state])
      mat.opacity = w.state === 'unknown' ? 0.55 : 1; mat.transparent = w.state === 'unknown'
      c.ring.visible = w.state === 'waiting_human'
    }
    for (const [id, c] of this.climbers) if (!live.has(id)) { this.scene.remove(c.mesh); disposeTree(c.mesh); this.climbers.delete(id) }
  }

  /** Idle climbers rest at the base of a creature chosen from the worker id. */
  private placeAtHome(c: ClimberView, ids: string[]) {
    if (!ids.length) return
    const v = this.creatures.get(ids[hashString(c.id) % ids.length])!
    const a = (hashString(c.id) % 628) / 100
    c.home.set(v.center.x + Math.cos(a) * (v.spec.torso.radii[0] + 0.9), 0.05, v.center.z + Math.sin(a) * (v.spec.torso.radii[2] + 0.9))
  }

  private animateClimbers(t: number, dt: number) {
    for (const c of this.climbers.values()) {
      const w = c.worker
      const goal = c.target.clone()
      const speed = w.state === 'working' || w.state === 'looping' ? 6 : 3
      const d = goal.clone().sub(c.pos)
      const step = Math.min(d.length(), speed * dt)
      if (d.length() > 1e-3) c.pos.add(d.normalize().multiplyScalar(step))
      const moving = c.pos.distanceTo(goal) > 0.05
      let y = 0, ox = 0, oz = 0, roll = 0
      if (moving) y = Math.abs(Math.sin(t * 9 + c.phase)) * 0.25 // scrambling
      else if (w.state === 'working') { y = Math.abs(Math.sin(t * 4 + c.phase)) * 0.08; ox = Math.sin(t * 3 + c.phase) * 0.05 }
      else if (w.state === 'looping' && c.cardId) { const s = slipPose(t, c.phase); ox = s.ox; oz = s.oz; y = s.oy; roll = s.roll }
      else if (w.state === 'waiting_human') { y = 0 }
      c.mesh.position.set(c.pos.x + ox, Math.max(c.pos.y + y + 0.25, 0.1), c.pos.z + oz)
      c.mesh.rotation.z = roll
      c.ring.scale.setScalar(1 + 0.25 * Math.sin(t * 3 + c.phase))
      c.mesh.scale.setScalar(w.state === 'idle' ? 0.8 : 1)
    }
    for (const b of this.beacons) (b.mesh.material as THREE.MeshBasicMaterial).opacity = 0.5 + 0.4 * Math.sin(t * 3)
  }

  // ---------------- selection ----------------
  /** `text` is what the pinned label says (the card's title and status); without it the label shows nothing. */
  select(cardId: string | null, text?: string) {
    if (text !== undefined) this.selectionText = text
    else if (cardId !== this.selectedCard) this.selectionText = ''
    this.selectedCard = cardId
    const p = cardId ? this.cardWorldPos(cardId) : null
    this.selection.visible = !!p
    this.selectionPin.visible = !!p
    if (!p) this.selectionText = ''
    if (p) {
      this.selection.position.copy(p).add(new THREE.Vector3(0, 0.15, 0))
      this.selection.scale.setScalar(this.selectionRadius(cardId!))
      this.selectionPin.scale.set(1, SELECT_PIN, 1)
      this.selectionPin.position.copy(p).add(new THREE.Vector3(0, 0.15 + SELECT_PIN / 2, 0))
    }
  }

  /** Ring radius: clearly wider than the scale it marks (a flat done scale and a tall blocked one alike), never tiny. */
  private selectionRadius(cardId: string): number {
    for (const v of this.creatures.values()) {
      const i = v.scaleIds.indexOf(cardId)
      if (i >= 0) return Math.max(1.0, v.scalePose[i].k * 1.5)
    }
    return 1.0
  }

  // ---------------- input ----------------
  private ndc(ev: PointerEvent | MouseEvent) {
    const r = this.canvas.getBoundingClientRect()
    return new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1)
  }
  /** Pick what is under a screen point. Exposed for tests and the screenshot driver. */
  pickAt(ndc: THREE.Vector2): { pick: Pick; label: string } | null {
    this.raycaster.setFromCamera(ndc, this.camera)
    const targets: THREE.Object3D[] = []
    for (const c of this.climbers.values()) targets.push(c.mesh)
    for (const v of this.creatures.values()) {
      if (v.scales.visible) targets.push(v.scales)
      targets.push(...v.carvingMeshes, v.group)
    }
    const hits = this.raycaster.intersectObjects(targets, true)
    for (const h of hits) {
      const o = h.object
      if (o.userData.kind === 'worker') return { pick: { kind: 'worker', id: o.userData.id }, label: `worker ${o.userData.id}` }
      if (o.userData.kind === 'scales' && h.instanceId != null) {
        const v = this.creatures.get(o.userData.project)!
        const id = v.scaleIds[h.instanceId]
        const card = this.snap?.projects.flatMap((p) => p.cards).find((c) => c.id === id)
        return { pick: { kind: 'card', id }, label: card ? `${card.title} · ${card.status_native}` : id }
      }
      if (o.userData.kind === 'carving' && h.instanceId != null) {
        const v = this.creatures.get(o.userData.project)!
        const info = v.carvingInfo[o.userData.index][h.instanceId]
        return { pick: { kind: 'doc', cardId: info.cardId, path: info.path, title: info.title }, label: `doc ${info.title}` }
      }
      if (o.userData.project) return { pick: { kind: 'project', id: o.userData.project }, label: this.creatures.get(o.userData.project)?.spec.name ?? '' }
    }
    return null
  }
  private inside(e: { clientX: number; clientY: number }) {
    const r = this.canvas.getBoundingClientRect()
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
  }
  private onDown = (e: PointerEvent) => {
    if (this.down && e.pointerId !== this.down.id) {
      // a second pointer while a press is in flight: it never replaces or finishes the first press's gesture
      this.down.multi = true
      if (this.drag) e.stopImmediatePropagation?.()
      return
    }
    this.down = { x: e.clientX, y: e.clientY, id: e.pointerId, multi: false }
    // a press on a climber is a possible drag; on anything else it stays an orbit
    const hit = e.button === 0 ? this.pickAt(this.ndc(e)) : null
    if (hit?.pick.kind === 'worker') {
      this.drag = { workerId: hit.pick.id, id: e.pointerId, cancelled: false }
      this.controls.enabled = false
      e.stopImmediatePropagation?.() // OrbitControls must not see this press, or it would capture the pointer
    }
  }
  /** Drop the gesture and give the camera back. Used by pointer-up, cancel, leave and dispose. */
  private endDrag() {
    this.drag = null
    this.controls.enabled = true
    this.canvas.style.cursor = 'grab'
  }
  /** The pointer left the canvas while held (implicit capture hides the leave event, so moves check bounds too). */
  private cancelDrag() {
    if (!this.drag) return
    this.drag.cancelled = true
    this.canvas.style.cursor = 'grab'
    this.cb.onHover(null, 0, 0)
  }
  private onUp = (e: PointerEvent) => {
    const d = this.down
    if (!d || e.pointerId !== d.id) return // another pointer's release changes nothing
    this.down = null
    const drag = this.drag
    if (drag) this.endDrag()
    // a cancelled gesture, or a release outside the canvas, produces neither a drop nor a pick (even within click slop)
    if (drag?.cancelled || !this.inside(e)) return
    if (isDrag(d, { x: e.clientX, y: e.clientY })) {
      // a drag that began on a climber is a drop; any other drag was an orbit. Either way it is not a click.
      if (!drag) return
      const out = dropOutcome(drag.workerId, this.pickAt(this.ndc(e))?.pick ?? null, ++this.dropSeq)
      if (out) this.cb.onDrop?.(out.open)
      return
    }
    if (d.multi) return // a pinch or second finger is not a click
    const hit = this.pickAt(this.ndc(e))
    this.cb.onPick(hit?.pick ?? null)
  }
  private onCancel = (e: PointerEvent) => {
    if (!this.down || e.pointerId !== this.down.id) return
    this.down = null
    if (this.drag) this.endDrag()
  }
  private onDbl = (e: MouseEvent) => {
    const hit = this.pickAt(this.ndc(e))
    if (hit?.pick.kind === 'project') this.focusCreature(hit.pick.id)
  }
  private onMove = (e: PointerEvent) => {
    if (this.drag && e.pointerId !== this.drag.id) return // only the dragging pointer drives the gesture
    this.lastPointer = { x: e.clientX, y: e.clientY }
    if (this.drag && !this.drag.cancelled && !this.inside(e)) this.cancelDrag()
    if (this.hoverQueued || (e.buttons && !this.drag)) return
    this.hoverQueued = true
    const gen = this.hoverGen
    requestAnimationFrame(() => {
      if (gen !== this.hoverGen) return // the pointer left after this was queued; leaving already reset the queue
      this.hoverQueued = false
      if (this.disposed) return
      const hit = this.pickAt(this.ndc({ clientX: this.lastPointer.x, clientY: this.lastPointer.y } as MouseEvent))
      if (this.drag) {
        if (this.drag.cancelled) return
        // while dragging a climber, only a scale is a valid drop; show that and nothing else
        const ok = hit?.pick.kind === 'card'
        this.canvas.style.cursor = ok ? 'copy' : 'no-drop'
        this.cb.onHover(ok ? 'Drop to choose a profile (does not claim)' : null, this.lastPointer.x, this.lastPointer.y)
        return
      }
      this.canvas.style.cursor = hit ? 'pointer' : 'grab'
      this.hoverProject = this.projectOfPick(hit?.pick ?? null)
      this.cb.onHover(hit?.label ?? null, this.lastPointer.x, this.lastPointer.y)
    })
  }
  private projectOfPick(p: Pick | null): string | null {
    if (!p) return null
    if (p.kind === 'project') return p.id
    const cardId = p.kind === 'card' ? p.id : p.kind === 'doc' ? p.cardId : null
    if (cardId) for (const v of this.creatures.values()) if (v.cardPos.has(cardId)) return v.spec.projectId
    return null
  }
  // leaving the canvas mid-drag cancels it: no drop, no change
  private hoverGen = 0 // bumped on pointerleave so hover work queued before it cannot run after it
  private onLeave = (e: PointerEvent) => {
    this.hoverGen++
    this.hoverQueued = false
    this.hoverProject = null
    this.cb.onHover(null, 0, 0)
    if (this.drag && e.pointerId === this.drag.id) { this.down = null; this.endDrag() }
  }

  // ---------------- loop ----------------
  /**
   * Resizing a pane delivers many sizes per frame. Only the last one is applied, once, at the start of the next frame
   * (`flushResize`, called by the loop before it renders), together with one reframe.
   */
  private pendingSize: { w: number; h: number } | null = null
  resize(w: number, h: number) {
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 2 || h < 2) return // a bad size must not reach the renderer or camera
    this.pendingSize = { w, h }
  }
  flushResize() {
    const s = this.pendingSize
    if (!s) return
    this.pendingSize = null
    this.renderer.setSize(s.w, s.h, false)
    this.camera.aspect = s.w / s.h
    this.camera.updateProjectionMatrix()
    this.viewW = s.w
    this.viewH = s.h
    if (!this.userMoved) this.frameValley(true)
    else if (this.focusedId) this.refocus() // a pane that changed size must not leave the approached creature cropped
  }

  private refocus() {
    const v = this.focusedId ? this.creatures.get(this.focusedId) : undefined
    if (!v) return
    const dest = this.fitCreature(v)
    if (!dest) return
    this.focus = null
    this.controls.target.copy(dest.target)
    this.camera.position.copy(dest.pos)
    this.controls.update()
  }

  private tmp = new THREE.Vector3()
  private loop = () => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.loop)
    const dt = Math.min(this.clock.getDelta(), 0.1)
    const t = this.clock.elapsedTime
    this.flushResize()
    if (this.focus) {
      this.focus.t = Math.min(1, this.focus.t + dt * 2.5)
      const k = this.focus.t * this.focus.t * (3 - 2 * this.focus.t) // ease in and out
      this.controls.target.lerpVectors(this.focus.fromT, this.focus.toT, k)
      this.camera.position.lerpVectors(this.focus.fromP, this.focus.toP, k)
      if (this.focus.t >= 1) this.focus = null
    }
    this.controls.update()
    setDepthRange(this.camera, this.camera.position.distanceTo(this.controls.target)) // follows the user's zoom too
    this.glowTime.value = t
    const pl = pulse(t)
    this.animateClimbers(t, dt)
    // legibility: past ~100 cards show scales only for creatures near the camera, aggregate bands otherwise
    for (const v of this.creatures.values()) {
      const dist = this.camera.position.distanceTo(v.center)
      const on = showScales(this.totalCards, dist, v.spec.radius)
      v.scales.visible = on
      v.claims.visible = on
      v.halo.visible = on
      ;(v.halo.material as THREE.MeshBasicMaterial).opacity = 0.13 * pl + 0.08
      v.bands.visible = !on
    }
    this.renderer.render(this.scene, this.camera)
    this.positionLabels()
    this.frameCount++
  }

  private placer = new LabelPlacer()
  /** Project each limb label, then drop the ones that would collide (see LabelPlacer); the rest fade with distance.
   *  Runs every frame, so it reuses the placer's pools and only touches the DOM for labels whose text or place changed. */
  private positionLabels() {
    const w = this.canvas.clientWidth || this.viewW, h = this.canvas.clientHeight || this.viewH
    const pl = this.placer
    pl.begin()
    const pinned = this.pinnedProject()
    const crowded = this.totalCards > CROWDED
    for (const v of this.creatures.values()) {
      const mine = v.spec.projectId === pinned
      for (const l of v.labels) {
        const n = l.limb.scales.length
        const key = crowded && n > 0 ? n : -1
        if (key !== l.textKey) {
          l.textKey = key
          const text = key >= 0 ? `${l.limb.title} · ${n}` : l.limb.title
          l.el.textContent = text
          l.width = text.length * 6.4 + 8
        }
        this.tmp.copy(l.world).project(this.camera)
        const inView = this.tmp.z < 1 && Math.abs(this.tmp.x) < 1.1 && Math.abs(this.tmp.y) < 1.1
        pl.add((this.tmp.x * 0.5 + 0.5) * w, (-this.tmp.y * 0.5 + 0.5) * h, l.width, inView ? this.camera.position.distanceTo(l.world) : Infinity, inView && mine)
      }
    }
    // climber rings: keep labels off them
    for (const c of this.climbers.values()) {
      this.tmp.copy(c.mesh.position).project(this.camera)
      if (this.tmp.z >= 1) continue
      const x = (this.tmp.x * 0.5 + 0.5) * w, y = (-this.tmp.y * 0.5 + 0.5) * h
      pl.addAvoid(x - 16, y - 16, x + 16, y + 16)
    }
    this.positionSelectionLabel(w, h)
    const fadeFrom = Math.max(45, this.frameDist * 1.2)
    pl.place(w, h, fadeFrom, fadeFrom + 35)
    let i = 0
    for (const v of this.creatures.values()) for (const l of v.labels) {
      const o = pl.out[i++]
      if (o.show !== l.shown) { l.shown = o.show; l.el.style.display = o.show ? 'block' : 'none' }
      if (!o.show) continue
      const x = Math.round(o.x * 10) / 10, y = Math.round(o.y * 10) / 10, op = Math.round(o.opacity * 100) / 100
      if (x !== l.sx) { l.sx = x; l.el.style.left = `${x}px` }
      if (y !== l.sy) { l.sy = y; l.el.style.top = `${y}px` }
      if (op !== l.so) { l.so = op; l.el.style.opacity = String(op) }
    }
  }

  /** The pinned label over the selected scale: its title and status, kept inside the pane, below the header band. */
  private positionSelectionLabel(w: number, h: number) {
    const p = this.selectedCard ? this.cardWorldPos(this.selectedCard) : null
    if (!p || !this.selectionText) { if (this.selectionLabel) this.selectionLabel.style.display = 'none'; return }
    if (!this.selectionLabel) {
      const el = document.createElement('div')
      el.className = 'foundry-selection-label'
      el.style.cssText = 'position:absolute;pointer-events:none;font:600 12px var(--dt-font-sans,system-ui);color:#111;background:#f4f1e6;border-radius:4px;padding:2px 7px;box-shadow:0 1px 6px #000a;white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis;transform:translate(-50%,-100%)'
      this.labelHost.appendChild(el)
      this.selectionLabel = el
    }
    const el = this.selectionLabel
    if (el.textContent !== this.selectionText) el.textContent = this.selectionText
    this.tmp.copy(p).add(new THREE.Vector3(0, 0.15 + SELECT_PIN, 0)).project(this.camera)
    if (this.tmp.z >= 1) { el.style.display = 'none'; return }
    const half = Math.min(120, w / 2 - 4)
    const x = Math.min(Math.max((this.tmp.x * 0.5 + 0.5) * w, half), w - half)
    const y = Math.min(Math.max((-this.tmp.y * 0.5 + 0.5) * h, 76), h - 4)
    el.style.display = 'block'
    el.style.left = `${Math.round(x)}px`
    el.style.top = `${Math.round(y)}px`
  }

  /** The project whose labels are always shown: the one under the pointer, else the one holding the selected card. */
  private hoverProject: string | null = null
  private pinnedProject(): string | null {
    if (this.hoverProject && this.creatures.has(this.hoverProject)) return this.hoverProject
    if (!this.selectedCard) return null
    for (const v of this.creatures.values()) if (v.cardPos.has(this.selectedCard)) return v.spec.projectId
    return null
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.canvas.removeEventListener('pointerdown', this.onDown)
    this.canvas.removeEventListener('pointerup', this.onUp)
    this.canvas.removeEventListener('pointermove', this.onMove)
    this.canvas.removeEventListener('pointerleave', this.onLeave)
    this.canvas.removeEventListener('pointercancel', this.onCancel)
    this.canvas.removeEventListener('dblclick', this.onDbl)
    this.controls.dispose()
    for (const v of this.creatures.values()) this.disposeCreature(v)
    this.creatures.clear()
    for (const b of this.beacons) { this.scene.remove(b.mesh); disposeTree(b.mesh) }
    this.beacons = []
    for (const c of this.climbers.values()) { this.scene.remove(c.mesh); disposeTree(c.mesh) }
    this.climbers.clear()
    // valley, selection ring and anything else still attached to the scene
    disposeTree(this.scene)
    this.scene.clear()
    this.selectionLabel?.remove()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
  }
}

// ---------------- geometry helpers ----------------
/**
 * Move a cached creature and every world-space coordinate derived from its centre (labels, card
 * positions, centre itself), so climbers, beacons and the selection ring stay on their cards.
 */
type Movable = { center: THREE.Vector3; group: THREE.Object3D; labels: { world: THREE.Vector3 }[]; cardPos: Map<string, THREE.Vector3> }
export function moveCreature(v: Movable, to: THREE.Vector3) {
  const d = to.clone().sub(v.center)
  if (d.lengthSq() === 0) return
  v.center.copy(to)
  v.group.position.copy(to)
  for (const l of v.labels) l.world.add(d)
  for (const p of v.cardPos.values()) p.add(d)
}

/** Cache key for a creature: changes whenever anything its cached spec, labels or bands show changes. */
export function creatureKey(p: Project): string {
  return JSON.stringify([
    p.name,
    p.epics.map((e) => [e.id, e.title]),
    p.cards.map((c) => [c.id, c.title, c.epic_id, c.status, c.docs.map((d) => [d.path, d.title])]),
  ])
}

/** Dispose every geometry, material and instanced resource under `root` (shared ones are safe to dispose twice). */
export function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh
    m.geometry?.dispose?.()
    const mat = m.material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
    else mat?.dispose?.()
    const im = o as THREE.InstancedMesh
    if (im.isInstancedMesh) im.dispose()
  })
}

function jitter(g: THREE.BufferGeometry, seed: number, amt: number) {
  const r = rng(seed)
  const p = g.attributes.position as THREE.BufferAttribute
  const memo = new Map<string, number>()
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`
    let k = memo.get(key)
    if (k === undefined) { k = 1 + (r() - 0.5) * amt * 2; memo.set(key, k) }
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k)
  }
  g.computeVertexNormals()
}

/** A tube along `path` whose radius follows `radii`, with a little seeded roughness. */
export function loft(path: V3[], radii: number[], seed: number, rings = 22, sides = 9): THREE.BufferGeometry {
  const r = rng(seed)
  const pos: number[] = [], idx: number[] = []
  for (let i = 0; i <= rings; i++) {
    const t = i / rings
    const f = frameAt(path, t)
    const n = radii.length - 1
    const ff = t * n, s = Math.min(Math.floor(ff), n - 1), u = ff - s
    const rad = radii[s] * (1 - u) + radii[s + 1] * u
    for (let j = 0; j < sides; j++) {
      const a = (j / sides) * Math.PI * 2
      const rough = 1 + (r() - 0.5) * 0.14
      const nx = Math.cos(a), ny = Math.sin(a)
      pos.push(
        f.p[0] + (f.n1[0] * nx + f.n2[0] * ny) * rad * rough,
        f.p[1] + (f.n1[1] * nx + f.n2[1] * ny) * rad * rough,
        f.p[2] + (f.n1[2] * nx + f.n2[2] * ny) * rad * rough,
      )
    }
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < sides; j++) {
    const a = i * sides + j, b = i * sides + ((j + 1) % sides), c = (i + 1) * sides + j, d = (i + 1) * sides + ((j + 1) % sides)
    idx.push(a, c, b, b, c, d)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/** The sub-path between t0 and t1 (for the aggregate status bands). */
export function subPath(path: V3[], radii: number[], t0: number, t1: number): { path: V3[]; radii: number[] } | null {
  if (t1 - t0 < 0.01) return null
  const pts: V3[] = [], rs: number[] = []
  const N = 4
  for (let k = 0; k <= N; k++) {
    const t = t0 + ((t1 - t0) * k) / N
    pts.push(frameAt(path, t).p)
    const n = radii.length - 1
    const ff = Math.min(Math.max(t, 0), 1) * n, s = Math.min(Math.floor(ff), n - 1), u = ff - s
    rs.push(radii[s] * (1 - u) + radii[s + 1] * u)
  }
  return { path: pts, radii: rs }
}
