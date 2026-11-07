// Minimal ambient declarations for the host-provided react modules (rewritten to shims at runtime by Hermes).
// @hermes/plugin-sdk is a real module: see hermes-sdk-shim.ts.
declare module 'react' {
  export function useEffect(f: () => void | (() => void), deps?: unknown[]): void
  export function useLayoutEffect(f: () => void | (() => void), deps?: unknown[]): void
  export function useRef<T>(v: T | null): { current: T | null }
  export function useState<T>(v: T | (() => T)): [T, (v: T | ((p: T) => T)) => void]
  export function useMemo<T>(f: () => T, deps: unknown[]): T
  export function useCallback<T extends (...a: any[]) => any>(f: T, deps: unknown[]): T
}
declare module 'react/jsx-runtime' {
  export function jsx(t: unknown, p: Record<string, unknown>, k?: string): unknown
  export function jsxs(t: unknown, p: Record<string, unknown>, k?: string): unknown
}
