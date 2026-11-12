import type { AgentEditSurface } from './agent-edits';
import type { EditEntry } from './inspector-edits';
import { createElement, type Dispatch } from "react";
import { paneLayout } from "./layout";
import type { PaneAction, PaneState } from "./pane-state";
import { contextFor, sameSelection, UNSORTED, type OutlineCreature, type Selection } from "./selection";
import { PlaceholderInspector, PlaceholderThread, type InspectorComponent, type ThreadComponent } from "./thread-port";

export interface FoundryPaneProps {
  state: PaneState;
  dispatch: Dispatch<PaneAction>;
  outline: readonly OutlineCreature[];
  Thread?: ThreadComponent;
  tools?: AgentEditSurface;
  history?: readonly EditEntry[];
  Inspector?: InspectorComponent;
}

const LINE = "1px solid var(--border)";
const chip = (on: boolean) => ({
  font: "inherit", fontSize: 12, padding: "2px 8px", borderRadius: 999, cursor: "pointer", border: LINE,
  background: on ? "var(--primary)" : "transparent", color: on ? "var(--primary-foreground)" : "var(--foreground)",
});

/** The picker row: creatures, and the chosen creature's limbs. Choosing again closes the drawer. */
function Picker({ state, dispatch, outline }: Pick<FoundryPaneProps, "state" | "dispatch" | "outline">) {
  const creature = outline.find((c) => c.projectId === state.selection?.projectId);
  const pick = (target: Selection) => dispatch({ type: "toggle", target });
  return createElement(
    "div",
    { "data-foundry": "picker", style: { display: "flex", flexWrap: "wrap", gap: 4, padding: "8px 10px", borderBottom: LINE, maxHeight: "30%", overflowY: "auto", flex: "0 0 auto" } },
    ...outline.map((c) => {
      const target: Selection = { kind: "creature", projectId: c.projectId };
      return createElement("button", { key: c.projectId, type: "button", "data-foundry": "creature", "aria-pressed": sameSelection(state.selection, target), style: chip(sameSelection(state.selection, target)), onClick: () => pick(target) }, c.name);
    }),
    ...(creature?.limbs ?? []).map((l) => {
      const target: Selection = { kind: "limb", projectId: creature!.projectId, sectionId: l.sectionId };
      return createElement("button", { key: l.sectionId ?? UNSORTED, type: "button", "data-foundry": "limb", "aria-pressed": sameSelection(state.selection, target), style: { ...chip(sameSelection(state.selection, target)), borderStyle: "dashed" }, onClick: () => pick(target) }, l.name);
    }),
  );
}

export function FoundryPane({ state, dispatch, outline, tools, history, Thread = PlaceholderThread, Inspector = PlaceholderInspector }: FoundryPaneProps) {
  const layout = paneLayout(state.selection);
  const context = contextFor(state.selection, outline);
  return createElement(
    "aside",
    {
      "data-foundry": "pane", "aria-label": "Foundry thread",
      style: { display: "flex", flexDirection: "column", flex: "0 0 auto", width: layout.width, minWidth: layout.minWidth, maxWidth: layout.maxWidth, minHeight: 0, boxSizing: "border-box", borderLeft: LINE, background: "var(--background)", color: "var(--foreground)", fontFamily: "var(--font-sans)" },
    },
    createElement(Picker, { state, dispatch, outline }),
    createElement(Thread, { context, lines: state.lines, tools, history }),
    layout.drawerOpen && context
      ? createElement(
          "section",
          { "data-foundry": "drawer", "aria-label": `Inspector: ${context.label}`, style: { flex: "0 1 auto", maxHeight: layout.drawerMaxHeight, display: "flex", flexDirection: "column", borderTop: LINE, background: "var(--card)", minHeight: 0 } },
          createElement(
            "header",
            { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", borderBottom: LINE, fontSize: 12 } },
            createElement("strong", null, context.label),
            createElement("button", { type: "button", "data-foundry": "drawer-close", "aria-label": "Close inspector", onClick: () => dispatch({ type: "close" }), style: { ...chip(false), border: 0 } }, "✕"),
          ),
          createElement(
            "div",
            { "data-foundry": "drawer-body", style: { padding: 10, overflowY: "auto", minHeight: 0 } },
            createElement(Inspector, { context, onEdit: (text: string) => dispatch({ type: "line", kind: "edit", text, about: context.label }) }),
          ),
        )
      : null,
  );
}
