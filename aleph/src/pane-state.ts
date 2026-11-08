import { contextFor, toggleSelection, type OutlineCreature, type Selection } from "./selection";

// A line in the pane's thread. `edit` is a form edit (written by the inspector drawer); `note` is anything else the thread
// shows. `about` is the label of what was selected when the line was added. The lines live here, in the plugin; nothing is
// sent to bb.
export interface ThreadLine { id: number; kind: "edit" | "note"; text: string; about: string | null }

export interface PaneState { selection: Selection | null; lines: readonly ThreadLine[]; nextId: number }

export type PaneAction =
  | { type: "toggle"; target: Selection }
  | { type: "close" }
  | { type: "line"; kind: ThreadLine["kind"]; text: string; about: string | null }
  | { type: "reconcile"; outline: readonly OutlineCreature[] };

export const initialPaneState: PaneState = { selection: null, lines: [], nextId: 1 };

/** Cap on kept lines, so a long session cannot grow the pane without bound. */
export const MAX_LINES = 200;

export function paneReducer(state: PaneState, action: PaneAction): PaneState {
  switch (action.type) {
    case "toggle": return { ...state, selection: toggleSelection(state.selection, action.target) };
    case "close": return state.selection ? { ...state, selection: null } : state;
    case "line": {
      const text = action.text.trim();
      if (!text) return state;
      const lines = [...state.lines, { id: state.nextId, kind: action.kind, text, about: action.about }].slice(-MAX_LINES);
      return { ...state, lines, nextId: state.nextId + 1 };
    }
    case "reconcile":
      // What a selection names can go away (a project removed, a section emptied): close the drawer rather than edit nothing.
      return state.selection && !contextFor(state.selection, action.outline) ? { ...state, selection: null } : state;
  }
}
