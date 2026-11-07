// Minimal ambient declarations for the host-provided modules (rewritten to shims at runtime by Hermes).
declare module '@hermes/plugin-sdk' {
  export const ROUTES_AREA: string
  export const SIDEBAR_NAV_AREA: string
  export const host: unknown
  export interface PluginContext {
    register(c: { id: string; area: string; order?: number; data?: Record<string, unknown>; render?: () => unknown }): void
    rest<T>(path: string, opts?: { method?: string; body?: unknown; timeoutMs?: number }): Promise<T>
  }
}
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
