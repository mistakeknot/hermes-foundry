import type { Selection } from "./selection";

// The Foundry pane sits at the right of the panel, about a fifth to a quarter of its width. The percentage keeps it
// proportional; the pixel bounds keep it usable on a very narrow or very wide window.
export const PANE_WIDTH_PCT = 22;
export const PANE_MIN_PX = 260;
export const PANE_MAX_PX = 420;
/** The drawer never takes more than this share of the pane, so the thread above it stays readable. */
export const DRAWER_MAX_PCT = 55;

export interface PaneLayout {
  /** CSS for the pane's width. */
  width: string;
  minWidth: number;
  maxWidth: number;
  /** The drawer is rendered only while something is selected. */
  drawerOpen: boolean;
  /** The thread always fills whatever the drawer leaves. */
  threadFlex: string;
  drawerMaxHeight: string;
}

export function paneLayout(selection: Selection | null): PaneLayout {
  return {
    width: `${PANE_WIDTH_PCT}%`,
    minWidth: PANE_MIN_PX,
    maxWidth: PANE_MAX_PX,
    drawerOpen: selection !== null,
    threadFlex: "1 1 0%",
    drawerMaxHeight: `${DRAWER_MAX_PCT}%`,
  };
}
