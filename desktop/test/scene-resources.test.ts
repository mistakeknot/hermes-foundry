import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { creatureKey, disposeTree } from '../src/scene'
import { buildFixture } from '../src/mock'

describe('creatureKey (cached metadata staleness)', () => {
  const base = () => structuredClone(buildFixture().projects[0])
  it('is stable for identical data', () => {
    expect(creatureKey(base())).toBe(creatureKey(base()))
  })
  it('changes with project name, epic title, card title/status and doc title', () => {
    const k = creatureKey(base())
    const a = base(); a.name += '!'; expect(creatureKey(a)).not.toBe(k)
    const b = base(); b.epics[0].title += '!'; expect(creatureKey(b)).not.toBe(k)
    const c = base(); c.cards[0].title += '!'; expect(creatureKey(c)).not.toBe(k)
    const d = base(); d.cards[0].status = d.cards[0].status === 'done' ? 'open' : 'done'; expect(creatureKey(d)).not.toBe(k)
    const e = base(); const card = e.cards.find((x) => x.docs.length)!; card.docs[0].title += '!'; expect(creatureKey(e)).not.toBe(k)
  })
})

describe('disposeTree', () => {
  it('disposes geometries, materials (incl. arrays) and instanced meshes', () => {
    const g = new THREE.BoxGeometry(), m1 = new THREE.MeshBasicMaterial(), m2 = new THREE.MeshBasicMaterial()
    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 4)
    const root = new THREE.Group()
    root.add(new THREE.Mesh(g, [m1, m2]), im)
    const spies = [g, m1, m2, im.geometry, im.material as THREE.Material].map((o) => {
      const s = vi.fn(); o.addEventListener('dispose', s); return s
    })
    const imSpy = vi.fn(); im.addEventListener('dispose', imSpy)
    disposeTree(root)
    spies.forEach((s) => expect(s).toHaveBeenCalledTimes(1))
    expect(imSpy).toHaveBeenCalledTimes(1)
  })
})
