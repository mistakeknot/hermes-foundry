import { createElement as h, useState, useEffect, useSyncExternalStore, type FormEvent } from 'react'
import { LINEAGES, pickLineage } from '../../desktop/src/creature'
import type { InspectorProps } from './thread-port'
import type { InspectorEdits } from './inspector-edits'

export interface InspectorFormProps extends InspectorProps {
  edits: InspectorEdits
  threads: readonly { id: string; projectId: string; displayTitle: string }[]
}
const field = { display: 'flex', flexDirection: 'column' as const, gap: 4, fontSize: 12 }
const control = { font: 'inherit', color: 'var(--foreground)', background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 6px', minWidth: 0 }

export function InspectorForm({ context, onEdit, edits, threads }: InspectorFormProps) {
  const revision = useSyncExternalStore(edits.subscribe, edits.version)
  const state = edits.project(context.projectId)
  const section = state.sections.find(s => s.id === context.sectionId)
  const [name, setName] = useState(''), [lineage, setLineage] = useState(''), [members, setMembers] = useState<string[]>([])
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => {
    setName(context.kind === 'creature' ? state.creature.name ?? context.projectName : section?.name ?? context.sectionName ?? '')
    setLineage(state.creature.lineage?.name ?? '')
    setMembers(section?.cardIds ?? context.threadIds)
    setError('')
  }, [context.kind, context.projectId, context.sectionId, revision])
  const run = async (fn: () => Promise<void>, text: string) => {
    setBusy(true); setError('')
    try { await fn(); onEdit(text) }
    catch (e) { setError((e as { code?: string }).code === 'duplicate_name' ? 'Name already exists' : e instanceof Error ? e.message : 'Could not save') }
    finally { setBusy(false) }
  }
  if (context.kind === 'limb' && context.sectionId === null) {
    return h('div', { style: field }, h('strong', null, 'Unsorted'), ...threads.filter(t => context.threadIds.includes(t.id)).map(t => h('div', { key: t.id }, t.displayTitle)))
  }
  const save = (e: FormEvent) => {
    e.preventDefault()
    void run(() => context.kind === 'creature'
      ? edits.saveCreature(context.projectId, { name, lineage: lineage ? { name: lineage } : {} })
      : edits.saveSection(context.projectId, context.sectionId!, name, members), context.kind === 'creature' ? `Name: ${name.trim()}; lineage: ${lineage || 'Seeded'}` : `Section: ${name.trim()} (${members.length} members)`)
  }
  const chosen = pickLineage(context.projectId, state.creature.lineage)
  return h('form', { onSubmit: save, style: { display: 'flex', flexDirection: 'column', gap: 10 } },
    h('fieldset', { disabled: busy || !edits.has(context.projectId), style: { display: 'flex', flexDirection: 'column', gap: 10, border: 0, padding: 0, margin: 0, minWidth: 0 } },
      h('label', { style: field }, 'Name', h('input', { style: control, value: name, required: true, maxLength: context.kind === 'creature' ? 120 : 80, onChange: (e: { target: { value: string } }) => setName(e.target.value) })),
      context.kind === 'creature'
        ? h('div', { style: field }, h('span', null, `This project is a ${chosen?.name ?? 'creature'}`),
          h('label', { style: field }, 'Lineage', h('select', { style: control, value: lineage, onChange: (e: { target: { value: string } }) => setLineage(e.target.value) },
            h('option', { value: '' }, 'Seeded'), ...[...LINEAGES].sort((a, b) => a.name.localeCompare(b.name)).map(l => h('option', { key: l.id, value: l.name }, l.name)))),
          h('div', { style: { display: 'flex', gap: 6 } },
            h('button', { type: 'button', style: control, onClick: () => void run(() => edits.saveCreature(context.projectId, { lineage: {} }), 'Seeded lineage') }, 'Seeded'),
            h('button', { type: 'button', style: control, onClick: () => void run(() => edits.reroll(context.projectId), 'Re-rolled lineage') }, 'Re-roll')))
        : h('div', { style: field }, h('strong', null, 'Members'), ...threads.filter(t => t.projectId === context.projectId).map(t => h('label', { key: t.id },
          h('input', { type: 'checkbox', checked: members.includes(t.id), onChange: (e: { target: { checked: boolean } }) => setMembers(old => e.target.checked ? [...old, t.id] : old.filter(x => x !== t.id)) }), ' ', t.displayTitle))),
      h('button', { type: 'submit', style: control }, busy ? 'Saving…' : 'Save')),
    error ? h('div', { role: 'alert', style: { fontSize: 12, color: 'var(--destructive)' } }, error) : null)
}
