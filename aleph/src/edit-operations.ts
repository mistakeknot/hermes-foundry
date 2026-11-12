// Schemas only, no imports: the server bundle uses this to advertise the tools and must not pull in the panel's edit code.
const string = { type: 'string', minLength: 1 }
const projectId = { ...string, pattern: '^[A-Za-z0-9_.-]{1,64}$' }
function operation(name: string, description: string, properties: Record<string, unknown>) {
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
export type OperationName = (typeof operations)[number]['name']
