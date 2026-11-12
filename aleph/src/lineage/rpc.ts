import { checkProject, preference, type CreaturePreference, type LineageStore } from './store'

// Standard Schema keeps the contract shared without introducing a validation dependency.
function schema<T>(parse: (raw: unknown) => T) {
  return { '~standard': { types: undefined as { input: unknown; output: T } | undefined, version: 1 as const, vendor: 'foundry', validate: (raw: unknown) => {
    try { return { value: parse(raw) } } catch (e) { return { issues: [{ message: String(e) }] } }
  } } }
}
const project = (raw: unknown): { projectId: string } => {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid input')
  const id = (raw as { projectId: string }).projectId
  if (typeof id !== 'string') throw new Error('Invalid project')
  checkProject(id); return { projectId: id }
}
export const lineageContract = {
  'lineage.get': { input: schema(project), output: schema(preference) },
  'lineage.set': { input: schema(raw => ({ ...project(raw), patch: preference((raw as { patch: unknown }).patch) })), output: schema(preference) },
}
export interface LineageRpcClient {
  call(method: 'lineage.get', input: { projectId: string }): Promise<CreaturePreference>
  call(method: 'lineage.set', input: { projectId: string; patch: CreaturePreference }): Promise<CreaturePreference>
}
export class RpcLineageStore implements LineageStore {
  constructor(private rpc: LineageRpcClient) {}
  get(projectId: string) { return this.rpc.call('lineage.get', { projectId }) }
  set(projectId: string, patch: CreaturePreference) { return this.rpc.call('lineage.set', { projectId, patch }) }
}
