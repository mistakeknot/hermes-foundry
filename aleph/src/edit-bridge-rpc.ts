// RPC the panel uses to take and finish a bridged call. Standard Schema, no validation dependency (as lineage/rpc.ts).
import type { PanelResult } from './edit-bridge'

function schema<T>(parse: (raw: unknown) => T) {
  return { '~standard': { types: undefined as { input: unknown; output: T } | undefined, version: 1 as const, vendor: 'foundry', validate: (raw: unknown) => {
    try { return { value: parse(raw) } } catch (e) { return { issues: [{ message: String(e) }] } }
  } } }
}
const record = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected an object')
  return raw as Record<string, unknown>
}
const id = (raw: unknown, key: string): string => {
  const v = record(raw)[key]
  if (typeof v !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(v)) throw new Error(`Invalid ${key}`)
  return v
}
export const editContract = {
  'edit.claim': { input: schema(raw => ({ callId: id(raw, 'callId'), paneId: id(raw, 'paneId') })), output: schema((raw): boolean => raw === true) },
  'edit.report': { input: schema(raw => {
    const r = record((raw as { result?: unknown }).result)
    if (typeof r.ok !== 'boolean') throw new Error('Invalid result')
    return { callId: id(raw, 'callId'), paneId: id(raw, 'paneId'), result: r as PanelResult }
  }), output: schema((raw): boolean => raw === true) },
}
