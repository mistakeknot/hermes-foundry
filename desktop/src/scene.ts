// three.js scene: valley, creatures (torso + lofted limbs + instanced scales + carvings), climbers, orbit camera, picking.
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { buildCreature, frameAt, layoutCreatures, type CreatureSpec, type LimbSpec, type Material, type V3 } from './creature'
import { hashString, rng } from './rng'
import type { Card, Snapshot, Worker } from './types'

export const STATUS_COLOR: Record<Card['status'], number> = {
  open: 0xd2c9ae, // bone
  running: 0xe6a93c, // amber
  blocked: 0xc2483a, // rust
  review: 0x7f8bdc, // dusk blue
  done: 0x5b8a57, // moss
  unknown: 0x7d7d7d, // grey
}
export const WORKER_COLOR: Record<Worker['state'], number> = {
  working: 0xffd36a, waiting_human: 0x6fd3ff, looping: 0xff6fa8, idle: 0xb9b2a0, unknown: 0xa6a6a6,
}
const MATERIAL_COLOR: Record<Material, number> = { stone: 0x77726a, lichen: 0x6d8650, coral: 0xc8735c }

export type Pick =
  | { kind: 'card'; id: string }
  | { kind: 'doc'; cardId: string; path: string; title: string }
  | { kind: 'worker'; id: string }
  | { kind: 'project'; id: string }

export interface SceneCallbacks {
  onPick(p: Pick | null): void
  onHover(label: string | null, x: number, y: number): void
}

/** Scales are drawn only when a creature is close enough, once the valley is crowded (legibility past ~100 cards). */
export const CROWDED = 100
export function showScales(totalCards: number, dist: number, radius: number): boolean {
  return totalCards <= CROWDED || dist < 7 + radius * 1.7
}

interface CreatureView {
  spec: CreatureSpec
  key: string
  group: THREE.Group
  center: THREE.Vector3
  scales: THREE.InstancedMesh
  scaleIds: string[]
  scaleBase: THREE.Matrix4[]
  bands: THREE.Group // aggregate status bands per limb (zoomed-out view)
  carvingMeshes: THREE.InstancedMesh[]
  carvingInfo: { cardId: string; path: string; title: string }[][]
  torso: THREE.Mesh
  labels: { el: HTMLElement; world: THREE.Vector3; limb: LimbSpec }[]
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
  private selection = new THREE.Mesh(new THREE.TorusGeometry(1, 0.08, 8, 24), new THREE.MeshBasicMaterial({ color: 0xffffff }))
  private raf = 0
  private clock = new THREE.Clock()
  private snap: Snapshot | null = null
  private totalCards = 0
  private selectedCard: string | null = null
  private focus: { from: THREE.Vector3; to: THREE.Vector3; t: number } | null = null
  private down: { x: number; y: number } | null = null
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
    this.scene.background = new THREE.Color(0x1d2622)
    this.scene.fog = new THREE.FogExp2(0x1d2622, 0.011)
    this.scene.add(new THREE.HemisphereLight(0xcfe3d4, 0x2a2219, 1.15))
    const sun = new THREE.DirectionalLight(0xffe2b8, 2.4)
    sun.position.set(30, 45, 20)
    this.scene.add(sun)
    this.buildValley()
    this.selection.visible = false
    this.selection.rotation.x = Math.PI / 2
    this.scene.add(this.selection)

    this.camera.position.set(0, 20, 30)
    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enablePan = false // orbit and zoom only
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.minDistance = 4
    this.controls.maxDistance = 70
    this.controls.maxPolarAngle = Math.PI * 0.47
    this.controls.target.set(0, 3, 0)

    canvas.addEventListener('pointerdown', this.onDown)
    canvas.addEventListener('pointerup', this.onUp)
    canvas.addEventListener('pointermove', this.onMove)
    canvas.addEventListener('pointerleave', this.onLeave)
    canvas.addEventListener('dblclick', this.onDbl)
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
      c.setHex(0x5d7345).lerp(new THREE.Color(0x77726a), t) // lichen floor to bare stone on the rim
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
    const rocks = new THREE.InstancedMesh(rockGeo, new THREE.MeshStandardMaterial({ color: 0x6e6a62, flatShading: true, roughness: 1 }), 70)
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
    this.snap = snap
    this.totalCards = snap.projects.reduce((n, p) => n + p.cards.length, 0)
    const specs = snap.projects.map(buildCreature)
    const spots = layoutCreatures(specs)
    const seen = new Set<string>()
    specs.forEach((spec, i) => {
      seen.add(spec.projectId)
      const proj = snap.projects[i]
      const key = JSON.stringify([proj.epics.map((e) => e.id), proj.cards.map((c) => [c.id, c.epic_id, c.docs.map((d) => d.path)])])
      let v = this.creatures.get(spec.projectId)
      if (!v || v.key !== key) {
        if (v) this.disposeCreature(v)
        v = this.makeCreature(spec, key, new THREE.Vector3(...spots[i]))
        this.creatures.set(spec.projectId, v)
      }
      v.group.position.set(...spots[i])
      this.recolor(v, proj.cards)
    })
    for (const [id, v] of this.creatures) if (!seen.has(id)) { this.disposeCreature(v); this.creatures.delete(id) }
    this.updateBeacons(snap)
    this.updateClimbers(snap)
    if (this.selectedCard) this.select(this.selectedCard)
    this.frameValley(false)
  }

  /** Move the camera target so all creatures are in view (only on first data, or when asked). */
  private framed = false
  frameValley(force: boolean) {
    if (this.framed && !force) return
    if (this.creatures.size === 0) return
    this.framed = true
    let maxR = 0
    for (const v of this.creatures.values()) maxR = Math.max(maxR, v.center.length() + v.spec.radius)
    this.controls.target.set(0, 3, 0)
    const d = Math.min(Math.max(maxR * 1.9 + 8, 16), 60)
    this.camera.position.set(d * 0.55, d * 0.55, d * 0.8)
  }

  focusCreature(projectId: string) {
    const v = this.creatures.get(projectId)
    if (!v) return
    const to = v.center.clone().add(new THREE.Vector3(0, v.spec.height * 0.4, 0))
    this.focus = { from: this.controls.target.clone(), to, t: 0 }
    const dir = this.camera.position.clone().sub(this.controls.target).normalize()
    const dist = Math.max(10, v.spec.radius * 2.3)
    this.camera.position.copy(to.clone().add(dir.multiplyScalar(dist)))
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
    const scales = new THREE.InstancedMesh(scaleGeo, new THREE.MeshStandardMaterial({ roughness: 0.55, flatShading: true }), Math.max(allScales.length, 1))
    scales.count = allScales.length
    const scaleBase: THREE.Matrix4[] = []
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
      labels.push({ el, world: new THREE.Vector3(tip[0], tip[1] + lift + limb.radii.at(-1)! + 0.5, tip[2]).add(center), limb })
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
        m.compose(new THREE.Vector3(s.pos[0], s.pos[1] + lift, s.pos[2]), q, new THREE.Vector3(s.size * 1.15, s.size * 1.15, s.size * 1.15))
        scales.setMatrixAt(si, m)
        scaleBase.push(m.clone())
        scaleIds.push(s.cardId)
        cardPos.set(s.cardId, new THREE.Vector3(s.pos[0], s.pos[1] + lift, s.pos[2]).add(center).add(nrm.clone().multiplyScalar(s.size * 0.3)))
        si++
      }
    }
    scales.userData = { kind: 'scales', project: spec.projectId }
    group.add(scales)
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
    return { spec, key, group, center, scales, scaleIds, scaleBase, bands, carvingMeshes, carvingInfo, torso, labels, cardPos, limbOf }
  }

  private recolor(v: CreatureView, cards: Card[]) {
    const byId = new Map(cards.map((c) => [c.id, c]))
    const col = new THREE.Color()
    v.scaleIds.forEach((id, i) => {
      const c = byId.get(id)
      col.setHex(STATUS_COLOR[c?.status ?? 'unknown'])
      v.scales.setColorAt(i, col)
    })
    if (v.scales.instanceColor) v.scales.instanceColor.needsUpdate = true
  }

  private disposeCreature(v: CreatureView) {
    this.scene.remove(v.group)
    v.group.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose?.() })
    v.labels.forEach((l) => l.el.remove())
    v.scales.dispose()
  }

  private updateBeacons(snap: Snapshot) {
    for (const b of this.beacons) { this.scene.remove(b.mesh); b.mesh.geometry.dispose() }
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
    for (const [id, c] of this.climbers) if (!live.has(id)) { this.scene.remove(c.mesh); this.climbers.delete(id) }
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
      let y = 0, ox = 0, oz = 0
      if (moving) y = Math.abs(Math.sin(t * 9 + c.phase)) * 0.25 // scrambling
      else if (w.state === 'working') { y = Math.abs(Math.sin(t * 4 + c.phase)) * 0.08; ox = Math.sin(t * 3 + c.phase) * 0.05 }
      else if (w.state === 'looping' && c.cardId) { ox = Math.cos(t * 2.4 + c.phase) * 0.7; oz = Math.sin(t * 2.4 + c.phase) * 0.7 }
      else if (w.state === 'waiting_human') { y = 0 }
      c.mesh.position.set(c.pos.x + ox, c.pos.y + y + 0.25, c.pos.z + oz)
      c.ring.scale.setScalar(1 + 0.25 * Math.sin(t * 3 + c.phase))
      c.mesh.scale.setScalar(w.state === 'idle' ? 0.8 : 1)
    }
    for (const b of this.beacons) (b.mesh.material as THREE.MeshBasicMaterial).opacity = 0.5 + 0.4 * Math.sin(t * 3)
  }

  // ---------------- selection ----------------
  select(cardId: string | null) {
    this.selectedCard = cardId
    const p = cardId ? this.cardWorldPos(cardId) : null
    this.selection.visible = !!p
    if (p) { this.selection.position.copy(p).add(new THREE.Vector3(0, 0.15, 0)); this.selection.scale.setScalar(0.9) }
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
  private onDown = (e: PointerEvent) => { this.down = { x: e.clientX, y: e.clientY } }
  private onUp = (e: PointerEvent) => {
    const d = this.down; this.down = null
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return // a drag is an orbit, not a click
    const hit = this.pickAt(this.ndc(e))
    this.cb.onPick(hit?.pick ?? null)
  }
  private onDbl = (e: MouseEvent) => {
    const hit = this.pickAt(this.ndc(e))
    if (hit?.pick.kind === 'project') this.focusCreature(hit.pick.id)
  }
  private onMove = (e: PointerEvent) => {
    this.lastPointer = { x: e.clientX, y: e.clientY }
    if (this.hoverQueued || e.buttons) return
    this.hoverQueued = true
    requestAnimationFrame(() => {
      this.hoverQueued = false
      if (this.disposed) return
      const hit = this.pickAt(this.ndc({ clientX: this.lastPointer.x, clientY: this.lastPointer.y } as MouseEvent))
      this.canvas.style.cursor = hit ? 'pointer' : 'grab'
      this.cb.onHover(hit?.label ?? null, this.lastPointer.x, this.lastPointer.y)
    })
  }
  private onLeave = () => this.cb.onHover(null, 0, 0)

  // ---------------- loop ----------------
  resize(w: number, h: number) {
    if (w < 2 || h < 2) return
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  private tmp = new THREE.Vector3()
  private loop = () => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.loop)
    const dt = Math.min(this.clock.getDelta(), 0.1)
    const t = this.clock.elapsedTime
    if (this.focus) {
      this.focus.t = Math.min(1, this.focus.t + dt * 2.5)
      this.controls.target.lerpVectors(this.focus.from, this.focus.to, this.focus.t)
      if (this.focus.t >= 1) this.focus = null
    }
    this.controls.update()
    this.animateClimbers(t, dt)
    // legibility: past ~100 cards show scales only for creatures near the camera, aggregate bands otherwise
    for (const v of this.creatures.values()) {
      const dist = this.camera.position.distanceTo(v.center)
      const on = showScales(this.totalCards, dist, v.spec.radius)
      v.scales.visible = on
      v.bands.visible = !on
    }
    this.renderer.render(this.scene, this.camera)
    this.positionLabels()
    this.frameCount++
  }

  private positionLabels() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight
    for (const v of this.creatures.values()) {
      const near = this.camera.position.distanceTo(v.center) < 60
      for (const l of v.labels) {
        this.tmp.copy(l.world).project(this.camera)
        const vis = near && this.tmp.z < 1 && Math.abs(this.tmp.x) < 1.1 && Math.abs(this.tmp.y) < 1.1
        l.el.style.display = vis ? 'block' : 'none'
        if (vis) { l.el.style.left = `${(this.tmp.x * 0.5 + 0.5) * w}px`; l.el.style.top = `${(-this.tmp.y * 0.5 + 0.5) * h}px` }
        const n = l.limb.scales.length
        const text = this.totalCards > CROWDED && n > 0 ? `${l.limb.title} · ${n}` : l.limb.title
        if (l.el.textContent !== text) l.el.textContent = text
      }
    }
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.canvas.removeEventListener('pointerdown', this.onDown)
    this.canvas.removeEventListener('pointerup', this.onUp)
    this.canvas.removeEventListener('pointermove', this.onMove)
    this.canvas.removeEventListener('pointerleave', this.onLeave)
    this.canvas.removeEventListener('dblclick', this.onDbl)
    this.controls.dispose()
    for (const v of this.creatures.values()) this.disposeCreature(v)
    this.renderer.dispose()
  }
}

// ---------------- geometry helpers ----------------
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
