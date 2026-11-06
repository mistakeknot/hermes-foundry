/** A canvas stand-in that dispatches pointer events the way a browser does: listeners run in registration order,
 *  stopImmediatePropagation stops the rest, and setPointerCapture is recorded. Real OrbitControls registers on it. */
export interface PtrInit { pointerId?: number; x?: number; y?: number; button?: number; buttons?: number; touch?: boolean }

export class FakeCanvas {
  style: Record<string, string> = {}
  clientWidth = 800
  clientHeight = 600
  /** pointer ids currently captured; with capture the browser still delivers moves outside and hides pointerleave */
  captured = new Set<number>()
  private ls: { type: string; fn: (e: any) => void }[] = []

  addEventListener(type: string, fn: (e: any) => void) { this.ls.push({ type, fn }) }
  removeEventListener(type: string, fn: (e: any) => void) { this.ls = this.ls.filter((l) => !(l.type === type && l.fn === fn)) }
  getBoundingClientRect() { return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 } }
  getRootNode() { return { addEventListener() {}, removeEventListener() {} } }
  setPointerCapture(id: number) { this.captured.add(id) }
  releasePointerCapture(id: number) { this.captured.delete(id) }
  hasPointerCapture(id: number) { return this.captured.has(id) }
  listenerCount(type: string) { return this.ls.filter((l) => l.type === type).length }

  /** Dispatch a pointer event; returns it so a test can inspect `stopped`. */
  fire(type: string, i: PtrInit = {}) {
    const e = {
      type, pointerId: i.pointerId ?? 1, pointerType: i.touch ? 'touch' : 'mouse', clientX: i.x ?? 0, clientY: i.y ?? 0, pageX: i.x ?? 0, pageY: i.y ?? 0,
      button: i.button ?? 0, buttons: i.buttons ?? (type === 'pointerup' ? 0 : 1), ctrlKey: false, metaKey: false, shiftKey: false,
      stopped: false,
      stopImmediatePropagation() { this.stopped = true },
      preventDefault() {},
    }
    for (const l of [...this.ls]) {
      if (l.type !== type) continue
      l.fn(e)
      if (e.stopped) break
    }
    return e
  }
}

export const asCanvas = (c: FakeCanvas) => c as unknown as HTMLCanvasElement
