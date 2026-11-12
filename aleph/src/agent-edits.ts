import { CommittedRefreshError, InspectorEdits, type EditEntry, type ProjectEdits } from './inspector-edits'
import { checkProject, preference } from './lineage/store'
import { checkCardId, normalizeName } from './sections/model'
import { SectionsError, type SectionsErrorCode } from './sections/types'

export type ToolCall =
  | { name: 'rename_section'; arguments: { projectId: string; sectionId: string; name: string } }
  | { name: 'move_thread'; arguments: { projectId: string; threadId: string; sectionId: string | null } }
  | { name: 'pick_lineage'; arguments: { projectId: string; name: string } }
  | { name: 'reroll_lineage'; arguments: { projectId: string } }
  | { name: 'undo_edit'; arguments: { editId: number } }
export type EditResult =
  | { ok: true; status: 'committed' | 'committed_refresh_failed'; editId: number; summary: string; state: ProjectEdits }
  | { ok: false; error: { code: SectionsErrorCode | 'invalid_input' | 'conflict' | 'write_failed'; message: string } }
export interface AgentEditSurface {
  readonly operations: typeof operations
  dispatch(call: unknown): Promise<EditResult>
  history(): EditEntry[]
}
interface Scope { projects: readonly { id: string }[]; threads: readonly { id: string; projectId: string }[] }
const string = { type: 'string', minLength: 1 }
const projectId = { ...string, pattern: '^[A-Za-z0-9_.-]{1,64}$' }
function operation(name: ToolCall['name'], description: string, properties: Record<string, unknown>) {
  return { name, description, parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } } as const
}
/** JSON Schema descriptions for callers; dispatch independently validates every raw call. */
export const operations = [
  operation('rename_section', 'Rename a section of a project.', { projectId, sectionId: string, name: { ...string, maxLength: 80 } }),
  operation('move_thread', 'Move a thread to a section, or null for Unsorted.', { projectId, threadId: string, sectionId: { type: ['string', 'null'], minLength: 1 } }),
  operation('pick_lineage', 'Choose a catalogue lineage by name.', { projectId, name: string }),
  operation('reroll_lineage', 'Choose the next lineage.', { projectId }),
  operation('undo_edit', 'Undo one recorded edit if its field has not changed.', { editId: { type: 'integer', minimum: 1 } }),
] as const
const invalid = (message: string): never => { throw Object.assign(new Error(message), { code: 'invalid_input' }) }
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('Expected an object')
  return raw as Record<string, unknown>
}
function parse(raw: unknown): ToolCall {
  const call = object(raw)
  if (Object.keys(call).some(k => k !== 'name' && k !== 'arguments')) invalid('Unknown call field')
  const spec = operations.find(x => x.name === call.name)
  if (!spec) return invalid('Unknown operation')
  const args = object(call.arguments), keys = Object.keys(spec.parameters.properties)
  if (Object.keys(args).length !== keys.length || Object.keys(args).some(k => !keys.includes(k))) invalid('Unexpected or missing argument')
  if (call.name === 'undo_edit') {
    if (!Number.isSafeInteger(args.editId) || (args.editId as number) < 1) invalid('Invalid edit id')
  } else {
    if (typeof args.projectId !== 'string') return invalid('Invalid project id')
    try { checkProject(args.projectId) } catch { throw new SectionsError('invalid_id', 'Invalid project id') }
    for (const key of keys.filter(k => k !== 'projectId')) {
      if (key === 'sectionId' && call.name === 'move_thread' && args[key] === null) continue
      if (typeof args[key] !== 'string') invalid('Expected string argument')
      if (key !== 'name') checkCardId(args[key])
    }
    if (call.name === 'rename_section') args.name = normalizeName(args.name)
    if (call.name === 'pick_lineage') {
      try { args.name = preference({ lineage: { name: args.name } }).lineage!.name } catch { invalid('Unknown lineage') }
    }
  }
  return { name: call.name, arguments: args } as ToolCall
}
const codes = new Set(['invalid_id', 'invalid_name', 'duplicate_name', 'not_found', 'unsafe_path', 'corrupt', 'invalid_input', 'conflict'])
export class AgentEdits implements AgentEditSurface {
  readonly operations = operations
  constructor(private edits: InspectorEdits, private scope: () => Scope) {}
  history = () => this.edits.history()
  dispatch = async (raw: unknown): Promise<EditResult> => {
    try {
      // Copy first: normalization never mutates the caller's arguments.
      const call = parse(structuredClone(raw))
      return await this.edits.exclusive(async writer => {
        const args = call.arguments
        const id = 'projectId' in args ? args.projectId : this.history().find(e => e.id === args.editId)?.projectId
        const scope = this.scope()
        if (!id || !scope.projects.some(p => p.id === id)) throw new SectionsError('not_found', 'No such project or edit')
        await writer.refresh(id)
        if (call.name === 'rename_section' || call.name === 'move_thread') {
          const target = call.arguments.sectionId
          if (target !== null && !this.edits.project(id).sections.some(s => s.id === target)) throw new SectionsError('not_found', 'No such section')
        }
        if (call.name === 'move_thread' && !scope.threads.some(t => t.id === call.arguments.threadId && t.projectId === id)) throw new SectionsError('not_found', 'No such thread in this project')
        let status: 'committed' | 'committed_refresh_failed' = 'committed'
        try {
          switch (call.name) {
            case 'rename_section': await writer.renameSection(id, call.arguments.sectionId, call.arguments.name); break
            case 'move_thread': await writer.moveCard(id, call.arguments.threadId, call.arguments.sectionId); break
            case 'pick_lineage': await writer.saveCreature(id, { lineage: { name: call.arguments.name } }); break
            case 'reroll_lineage': await writer.reroll(id); break
            case 'undo_edit': await writer.undo(call.arguments.editId); break
          }
        } catch (error) {
          if (!(error instanceof CommittedRefreshError)) throw error
          status = 'committed_refresh_failed'
        }
        const entry = this.history().at(-1)!
        return { ok: true as const, status, editId: entry.id, summary: entry.summary, state: this.edits.project(id) }
      })
    } catch (error) {
      const code = (error as { code?: string } | null)?.code
      return { ok: false, error: { code: (codes.has(code ?? '') ? code : 'write_failed') as Extract<EditResult, { ok: false }>['error']['code'], message: code && codes.has(code) && error instanceof Error ? error.message : 'Could not save edit' } }
    }
  }
}
