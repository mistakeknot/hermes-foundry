import type { BbSectionsSdk } from './bb-backend'
import { formatBbCheck, runBbSectionsCheck, type BbCheckOptions, type BbCheckReport } from './bb-runtime-check'

/** Name of the console entry point installed on `globalThis` while the panel is mounted. */
export const CHECK_GLOBAL = '__foundryBbSectionsCheck'

export type BbSectionsCheckFn = (opts?: BbCheckOptions) => Promise<BbCheckReport>

/**
 * Installs `globalThis.__foundryBbSectionsCheck(opts?)`, which runs the runtime check against `sdk`, logs one line per step to the
 * console and resolves the report. Returns the cleanup that removes it (only if it is still ours). Does nothing and returns a no-op
 * when the SDK object does not have the sections API (an older bb, or a test host).
 */
export function installBbSectionsCheck(sdk: BbSectionsSdk | null | undefined, target: Record<string, unknown> = globalThis as Record<string, unknown>): () => void {
  // Typed as the port, so building the panel proves the real `useSdk()` client satisfies it; the guard is for hosts without the API.
  const s = sdk as Partial<BbSectionsSdk> | null | undefined
  if (!s?.threadSections || !s.threads) return () => {}
  const fn: BbSectionsCheckFn = async (opts) => {
    const report = await runBbSectionsCheck(sdk as BbSectionsSdk, opts)
    console.log(formatBbCheck(report))
    return report
  }
  target[CHECK_GLOBAL] = fn
  return () => { if (target[CHECK_GLOBAL] === fn) delete target[CHECK_GLOBAL] }
}
