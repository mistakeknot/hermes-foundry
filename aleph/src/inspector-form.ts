import { createElement as h, useState, useEffect, useRef, useSyncExternalStore, type FormEvent } from 'react'
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
  // A draft belongs to one selection. Changing sidebar objects must not change this identity.
  return h(InspectorDraft, { key: JSON.stringify([context.kind, context.projectId, context.sectionId]), context, onEdit, edits, threads })
}

function InspectorDraft({ context, onEdit, edits, threads }: InspectorFormProps) {
  const revision = useSyncExternalStore(edits.subscribe, edits.version)
  const state = edits.project(context.projectId)
  const section = state.sections.find(s => s.id === context.sectionId)
  const dirty = useRef({ name: false, lineage: false, members: false })
  const [name, setName] = useState(''), [lineage, setLineage] = useState(''), [members, setMembers] = useState<string[]>([])
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!dirty.current.name) setName(context.kind === 'creature' ? state.creature.name ?? context.projectName : section?.name ?? context.sectionName ?? '')
    if (!dirty.current.lineage) setLineage(state.creature.lineage?.name ?? '')
    if (!dirty.current.members) setMembers(section?.cardIds ?? context.threadIds)
  }, [context.kind, context.projectId, context.sectionId, context.projectName, context.sectionName, revision])
  const run = async (fn: () => Promise<void>, text: string, saved: 'all' | 'lineage' = 'all') => {
    setBusy(true); setError('')
    try {
      await fn()
      const committed = edits.project(context.projectId)
      if (saved === 'all') {
        dirty.current = { name: false, lineage: false, members: false }
        const limb = committed.sections.find(s => s.id === context.sectionId)
        setName(context.kind === 'creature' ? committed.creature.name ?? context.projectName : limb?.name ?? context.sectionName ?? '')
        setMembers(limb?.cardIds ?? context.threadIds)
      } else dirty.current.lineage = false
      setLineage(committed.creature.lineage?.name ?? '')
      onEdit(text)
    }
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
      h('label', { style: field }, 'Name', h('input', { style: control, value: name, required: true, maxLength: context.kind === 'creature' ? 120 : 80, onChange: (e: { target: { value: string } }) => { dirty.current.name = true; setName(e.target.value) } })),
      context.kind === 'creature'
        ? h('div', { style: field }, h('span', null, `This project is a ${chosen?.name ?? 'creature'}`),
          h('label', { style: field }, 'Lineage', h('select', { style: control, value: lineage, onChange: (e: { target: { value: string } }) => { dirty.current.lineage = true; setLineage(e.target.value) } },
            h('option', { value: '' }, 'Seeded'), ...[...LINEAGES].sort((a, b) => a.name.localeCompare(b.name)).map(l => h('option', { key: l.id, value: l.name }, l.name)))),
          h('div', { style: { display: 'flex', gap: 6 } },
            h('button', { type: 'button', style: control, onClick: () => void run(() => edits.saveCreature(context.projectId, { lineage: {} }), 'Seeded lineage', 'lineage') }, 'Seeded'),
            h('button', { type: 'button', style: control, onClick: () => void run(() => edits.reroll(context.projectId), 'Re-rolled lineage', 'lineage') }, 'Re-roll')))
        : h('div', { style: field }, h('strong', null, 'Members'), ...threads.filter(t => t.projectId === context.projectId).map(t => h('label', { key: t.id },
          h('input', { type: 'checkbox', checked: members.includes(t.id), onChange: (e: { target: { checked: boolean } }) => { dirty.current.members = true; setMembers(old => e.target.checked ? [...old, t.id] : old.filter(x => x !== t.id)) } }), ' ', t.displayTitle))),
      h('button', { type: 'submit', style: control }, busy ? 'Saving…' : 'Save')),
    error ? h('div', { role: 'alert', style: { fontSize: 12, color: 'var(--destructive)' } }, error) : null)
}
