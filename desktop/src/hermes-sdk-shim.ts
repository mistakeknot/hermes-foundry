// Stand-in for the host-provided '@hermes/plugin-sdk' module. Hermes injects the real one at runtime, so the Hermes
// bundle (scripts/build.mjs) keeps the import external and never reads this file. It exists so that (1) tsc has types
// for the import and (2) another host's bundler can resolve the same import (the Aleph plugin does, see aleph/).
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar-nav'
export const host: unknown = {}
export interface PluginContext {
  register(c: { id: string; area: string; order?: number; data?: Record<string, unknown>; render?: () => unknown }): void
  rest<T>(path: string, opts?: { method?: string; body?: unknown; timeoutMs?: number }): Promise<T>
}
