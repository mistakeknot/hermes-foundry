/**
 * Run `load` and hand its result (or null on failure) to `apply`, unless the returned cancel function
 * was called first. Use as a React effect body so a response that arrives after the effect re-ran or
 * unmounted (selecting worker B while A is pending) is dropped instead of shown under the wrong id.
 */
export function loadUnlessCancelled<T>(load: () => Promise<T>, apply: (v: T | null) => void): () => void {
  let cancelled = false
  load().then((v) => { if (!cancelled) apply(v) }, () => { if (!cancelled) apply(null) })
  return () => { cancelled = true }
}
