import { createElement, type ReactNode } from "react";
import type { ThreadLine } from "./pane-state";
import type { SelectionContext } from "./selection";

// The two seams of the pane. The thread (the real Foundry thread arrives later) and the drawer content (the inspector forms
// arrive later) are components behind these small interfaces, so the shell does not change when they land.

/** The thread area. `context` is the current selection, attached to the conversation; `lines` are what has happened so far. */
export interface ThreadProps { context: SelectionContext | null; lines: readonly ThreadLine[] }
export type ThreadComponent = (props: ThreadProps) => ReactNode;

/** The drawer's content. `onEdit` records a form edit as a line in the thread; it does not write to bb. */
export interface InspectorProps { context: SelectionContext; onEdit: (text: string) => void }
export type InspectorComponent = (props: InspectorProps) => ReactNode;

const MUTED = { color: "var(--muted-foreground)" };

/** Stand-in until the Foundry thread exists: shows the attached context and the lines, nothing more. */
export const PlaceholderThread: ThreadComponent = ({ context, lines }) =>
  createElement(
    "div",
    { "data-foundry": "thread", style: { display: "flex", flexDirection: "column", gap: 6, padding: 10, overflowY: "auto", flex: "1 1 0%", minHeight: 0, fontSize: 13 } },
    context
      ? createElement("div", { "data-foundry": "thread-context", style: { padding: "2px 8px", borderRadius: 999, border: "1px solid var(--border)", alignSelf: "flex-start", fontSize: 12 } }, `Context: ${context.label}`)
      : createElement("div", { style: { ...MUTED, fontSize: 12 } }, "No creature or limb selected."),
    lines.length === 0 ? createElement("div", { style: MUTED }, "The Foundry thread will appear here.") : null,
    ...lines.map((l) =>
      createElement("div", { key: l.id, "data-foundry": `line-${l.kind}`, style: l.kind === "edit" ? { ...MUTED, fontSize: 12 } : undefined }, l.about ? `${l.about}: ${l.text}` : l.text),
    ),
  );

/** Stand-in for the inspector forms. */
export const PlaceholderInspector: InspectorComponent = ({ context }) =>
  createElement("div", { "data-foundry": "inspector-placeholder", style: { ...MUTED, fontSize: 12 } }, `Forms for ${context.label} will appear here.`);
