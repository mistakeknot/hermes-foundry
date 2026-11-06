// Nov 7 integration-gate probe. Not the product: proves (1) the runtime bundle loads,
// (2) three.js renders under the desktop's CSP, (3) what ctx.rest can reach.
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useRef, useState } from 'react'
import { ROUTES_AREA, SIDEBAR_NAV_AREA, host } from '@hermes/plugin-sdk'
import * as THREE from 'three'

type Probe = Record<string, unknown>
const probe: Probe = { startedAt: new Date().toISOString() }
;(globalThis as any).__foundryProbe = probe

function renderCheck(canvas: HTMLCanvasElement): Probe {
  const r: Probe = {}
  try {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
    const gl = renderer.getContext()
    r.webgl = gl instanceof WebGL2RenderingContext ? 'webgl2' : 'webgl1'
    r.renderer = String(gl.getParameter(gl.VERSION))
    renderer.setSize(canvas.clientWidth || 480, canvas.clientHeight || 300, false)
    renderer.setClearColor(0x000000, 1)
    const scene = new THREE.Scene()
    const cam = new THREE.PerspectiveCamera(50, (canvas.width || 480) / (canvas.height || 300), 0.1, 100)
    cam.position.set(0, 0, 4)
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 1),
      new THREE.MeshStandardMaterial({ color: 0x88aa66, flatShading: true })
    )
    scene.add(mesh, new THREE.DirectionalLight(0xffffff, 3), new THREE.AmbientLight(0xffffff, 0.6))
    renderer.render(scene, cam)
    const px = new Uint8Array(4)
    gl.readPixels(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
    r.centerPixel = Array.from(px)
    r.rendered = px[0] + px[1] + px[2] > 30
    let t = 0
    const tick = () => {
      t += 0.01
      mesh.rotation.set(t, t * 1.3, 0)
      renderer.render(scene, cam)
      raf = requestAnimationFrame(tick)
    }
    let raf = requestAnimationFrame(tick)
    ;(canvas as any).__dispose = () => { cancelAnimationFrame(raf); renderer.dispose() }
  } catch (e) {
    r.error = String(e)
  }
  return r
}

async function restCheck(rest: (p: string, o?: any) => Promise<unknown>): Promise<Probe> {
  const r: Probe = {}
  const attempt = async (key: string, path: string) => {
    try { r[key] = { ok: true, value: JSON.stringify(await rest(path)).slice(0, 200) } }
    catch (e) { r[key] = { ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) } }
  }
  await attempt('own /snapshot', '/snapshot')
  await attempt('other plugin via ..', '/../kanban/board')
  return r
}

function ProbePage({ rest }: { rest: (p: string, o?: any) => Promise<unknown> }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<Probe>({})
  useEffect(() => {
    const c = ref.current!
    const render = renderCheck(c)
    Object.assign(probe, { render })
    setState(s => ({ ...s, render }))
    restCheck(rest).then(rc => { probe.rest = rc; setState(s => ({ ...s, rest: rc })) })
    return () => (c as any).__dispose?.()
  }, [])
  return jsxs('div', {
    style: { padding: 16, display: 'flex', gap: 16, height: '100%', boxSizing: 'border-box' },
    'data-testid': 'foundry-probe',
    children: [
      jsx('canvas', { ref, width: 480, height: 300, style: { width: 480, height: 300, borderRadius: 8 } }),
      jsx('pre', { id: 'foundry-probe-out', style: { fontSize: 11, whiteSpace: 'pre-wrap', maxWidth: 520 }, children: JSON.stringify(state, null, 2) })
    ]
  })
}

export default {
  id: 'foundry',
  name: 'Foundry (probe)',
  description: 'Integration gate probe: three.js under CSP + REST scope.',
  register(ctx: any) {
    probe.sdkHost = typeof host
    ctx.register({
      id: 'page',
      area: ROUTES_AREA,
      data: { path: '/foundry' },
      render: () => jsx(ProbePage, { rest: ctx.rest })
    })
    ctx.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      order: 60,
      data: { codicon: 'beaker', label: 'Foundry', path: '/foundry' }
    })
  }
}
