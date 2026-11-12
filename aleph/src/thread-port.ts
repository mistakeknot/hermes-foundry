import type { AgentEditSurface } from './agent-edits';
import type { EditEntry } from './inspector-edits';
import { createElement, useState, type ReactNode } from "react";
import type { ThreadLine } from "./pane-state";
import type { SelectionContext } from "./selection";

// The thread and inspector stay behind small interfaces so a provider transport can be added without changing the shell.

/** The thread area. `context` is the current selection, attached to the conversation; `lines` are what has happened so far. */
export interface ThreadProps { context: SelectionContext | null; lines: readonly ThreadLine[]; tools?: AgentEditSurface; history?: readonly EditEntry[] }
export type ThreadComponent = (props: ThreadProps) => ReactNode;

/** The drawer's content. `onEdit` records a form edit as a line in the thread; it does not write to bb. */
export interface InspectorProps { context: SelectionContext; onEdit: (text: string) => void }
export type InspectorComponent = (props: InspectorProps) => ReactNode;

const MUTED = { color: "var(--muted-foreground)" };

/** Provider-free thread surface: attached context, shared edit history and undo. */
export const PlaceholderThread: ThreadComponent = ({ context, lines, tools, history = [] }) => {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const undo = async (editId: number) => {
    if (!tools || busy) return;
    setBusy(true); setError('');
    try {
      const result = await tools.dispatch({ name: 'undo_edit', arguments: { editId } });
      if (!result.ok) setError(result.error.message);
      else if (result.status === 'committed_refresh_failed') setError('Saved, but could not refresh inspector');
    } finally { setBusy(false); }
  };
  return createElement(
    "div",
    { "data-foundry": "thread", style: { display: "flex", flexDirection: "column", gap: 6, padding: 10, overflowY: "auto", flex: "1 1 0%", minHeight: 0, fontSize: 13 } },
    context
      ? createElement("div", { "data-foundry": "thread-context", style: { padding: "2px 8px", borderRadius: 999, border: "1px solid var(--border)", alignSelf: "flex-start", fontSize: 12 } }, `Context: ${context.label}`)
      : createElement("div", { style: { ...MUTED, fontSize: 12 } }, "No creature or limb selected."),
    lines.length === 0 && history.length === 0 ? createElement("div", { style: MUTED }, "The Foundry thread will appear here.") : null,
    ...history.map(e => createElement('div', { key: `edit-${e.id}`, 'data-foundry': 'line-edit', style: { ...MUTED, fontSize: 12 } },
      e.summary,
      tools && e.undoable ? createElement('button', { type: 'button', disabled: busy, onClick: () => void undo(e.id), 'aria-label': `Undo ${e.summary}` }, 'Undo') : null)),
    error ? createElement('div', { role: 'alert' }, error) : null,
    ...lines.map((l) =>
      createElement("div", { key: l.id, "data-foundry": `line-${l.kind}`, style: l.kind === "edit" ? { ...MUTED, fontSize: 12 } : undefined }, l.about ? `${l.about}: ${l.text}` : l.text),
    ),
  );
};

/** Stand-in for the inspector forms. */
export const PlaceholderInspector: InspectorComponent = ({ context }) =>
  createElement("div", { "data-foundry": "inspector-placeholder", style: { ...MUTED, fontSize: 12 } }, `Forms for ${context.label} will appear here.`);
