import { createElement, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type FunctionComponent } from "react";
import { experimental_useSidebarThreads, useSdk, useRpc } from "@get-bb/plugin-sdk/app";
import foundry from "../../desktop/src/plugin";
import { LiveApi, restFromApi } from "../../desktop/src/live";
import { fromSidebar } from "./from-sidebar";
import { FoundryPane } from "./pane";
import { initialPaneState, paneReducer } from "./pane-state";
import { installBbSectionsCheck } from "./sections/bb-check-global";
import { buildOutline } from "./selection";
import { BbSectionsBackend } from './sections/bb-backend';
import { InspectorEdits } from './inspector-edits';
import { InspectorForm } from './inspector-form';
import { InspectorLiveApi } from './inspector-live';
import { RpcLineageStore, lineageContract } from './lineage/rpc';
import { AgentEdits } from './agent-edits';
import type { ThreadComponent } from './thread-port';
import type { InspectorProps } from './thread-port';

// The pane is the unchanged Hermes one. It is mounted by running the Hermes plugin's own `register` against a small
// context: `register` hands back the page's render function, and `rest` is served from the live thread list instead of
// a Hermes HTTP router. Nothing is copied or forked, so a fix to the pane lands in both hosts.
// How often the board re-reads the clock. A card turns "done" after a day idle, which no sidebar update announces.
const CLOCK_TICK_MS = 60_000;

// bb gives a panel a body that runs under its title bar (the traffic lights and the "Foundry" title) and under the
// navigation rail's edge, and expects the panel to leave `--bb-app-chrome-row-height` free at the top. A panel body that
// is absolutely positioned against the window instead (as this one first was) draws its header under the title bar and
// centres the valley on a box wider than what is visible, so the scene looks cropped.
const CHROME_TOP = "var(--bb-app-chrome-row-height, 3rem)";
const FILL: Record<string, string | number> = { display: "flex", flexDirection: "column", flex: "1 1 0%", minHeight: 0, minWidth: 0, width: "100%", height: "100%", boxSizing: "border-box", paddingTop: CHROME_TOP };

// The unchanged Hermes pane reads Hermes' `--dt-*` theme variables; bb names the same roles without the prefix. Aliasing them
// on the panel's own wrapper makes the pane (and the 3D stage, which reads `--dt-background`) follow bb's light or dark
// theme live, with no change to the pane itself. A variable bb lacks falls back to the pane's own default.
export const THEME_ALIASES: Record<string, string> = {
  "--dt-background": "var(--background)",
  "--dt-foreground": "var(--foreground)",
  "--dt-card": "var(--card)",
  "--dt-border": "var(--border)",
  "--dt-muted-foreground": "var(--muted-foreground)",
  "--dt-primary": "var(--primary)",
  "--dt-primary-foreground": "var(--primary-foreground)",
  "--dt-destructive": "var(--destructive)",
  "--dt-font-sans": "var(--font-sans)",
  "--dt-font-mono": "var(--font-mono)",
};
const THEMED: Record<string, string | number> = { ...FILL, ...THEME_ALIASES, background: "var(--background)", color: "var(--foreground)" };

const ROW: Record<string, string | number> = { ...THEMED, flexDirection: "row" };

export const FoundryPanel: FunctionComponent<{ Thread?: ThreadComponent }> = ({ Thread }) => {
  const sidebar = experimental_useSidebarThreads();
  const sdk = useSdk();
  const rpc = useRpc<typeof lineageContract>();
  const edits = useMemo(() => new InspectorEdits(new BbSectionsBackend(sdk), new RpcLineageStore(rpc)), [sdk, rpc]);
  const revision = useSyncExternalStore(edits.subscribe, edits.version);
  const [editError, setEditError] = useState('');
  // A dev entry point, not UI: lets the bb sections backend be exercised against the real SDK from the loaded plugin's console.
  useEffect(() => installBbSectionsCheck(sdk), [sdk]);
  const api = useRef<LiveApi | null>(null);
  const ready = sidebar.status === "ready";
  const failed = sidebar.status === "error";
  const sidebarRef = useRef(sidebar);
  sidebarRef.current = sidebar;

  // The pane's outline comes from the latest ready thread list; after a later failure it keeps the last one, like the board.
  const lastReady = useRef<typeof sidebar | null>(null);
  if (ready) lastReady.current = sidebar;
  const source = lastReady.current?.status === 'ready' ? lastReady.current : null;
  const scope = useRef(source);
  scope.current = source;
  const tools = useMemo(() => new AgentEdits(edits, () => scope.current ?? { projects: [], threads: [] }), [edits]);
  const projected = useMemo(() => source ? edits.sidebar(source) : null, [source, edits, revision]);
  const outline = useMemo(() => projected ? buildOutline(projected) : [], [projected]);
  useEffect(() => {
    if (!source) return;
    let active = true;
    void Promise.all(source.projects.map(p => edits.refresh(p.id))).then(() => { if (active) setEditError(''); }, () => { if (active) setEditError('Could not load inspector'); });
    return () => { active = false; };
  }, [source, edits]);
  const inspectorData = useRef({ source, editError });
  inspectorData.current = { source, editError };
  // The component type stays fixed while its data changes, preserving the selected item's draft.
  const Inspector = useMemo(() => (props: InspectorProps) => createElement('div', null,
    inspectorData.current.editError ? createElement('div', { role: 'alert' }, inspectorData.current.editError) : null,
    createElement(InspectorForm, { ...props, onEdit: () => {}, edits, threads: inspectorData.current.source?.threads ?? [] })), [edits]);
  const [pane, dispatch] = useReducer(paneReducer, initialPaneState);
  useEffect(() => { dispatch({ type: "reconcile", outline }); }, [outline]);

  if (ready && !api.current) {
    api.current = new InspectorLiveApi(edits);
    api.current.update(fromSidebar(projected!, Date.now()));
  }
  useEffect(() => {
    if (projected && api.current) api.current.update(fromSidebar(projected, Date.now()));
  }, [projected]);
  useEffect(() => {
    const timer = setInterval(() => {
      const current = sidebarRef.current;
      if (current.status === "ready" && api.current) api.current.update(fromSidebar(edits.sidebar(current), Date.now()));
    }, CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [edits]);

  // Mount the pane only once there is live data. Mounting on a failure would make the unchanged pane pick its built-in
  // fixture data and keep it even after the thread list recovers, so a failure before the first data shows an error.
  const page = useMemo(() => {
    if (!ready && !api.current) return null;
    let render: (() => unknown) | null = null;
    foundry.register({
      rest: restFromApi(() => api.current),
      register: (c: { id: string; render?: () => unknown }) => {
        if (c.id === "page") render = c.render ?? null;
      },
    } as never);
    return render ? (render as () => unknown)() : null;
    // The pane reads its transport once when it mounts, so mount it once, after the first data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready || api.current !== null]);

  if (!page) {
    const message = failed ? "Couldn't load threads. Foundry will draw them when the thread list is available." : "Loading threads…";
    return createElement("div", { style: { ...THEMED, paddingLeft: 16, paddingRight: 16, paddingBottom: 16, paddingTop: `calc(${CHROME_TOP} + 16px)` } }, message);
  }
  // The board (left) and the Foundry pane (right, about a fifth of the width) sit side by side below the chrome row.
  // The board is laid out against its wrapper (position: relative). Inspector writes use the shared edit service.
  return createElement(
    "div",
    { style: ROW },
    createElement(
      "div",
      { style: { position: "relative", flex: "1 1 0%", minHeight: 0, minWidth: 0 } },
      createElement("div", { style: { position: "absolute", inset: 0 } }, page as never),
    // After the first data, a later failure keeps the last board but says it may be out of date.
    failed
      ? createElement(
          "div",
          { style: { position: "absolute", left: 8, top: 8, padding: "4px 8px", borderRadius: 6, background: "var(--card)", color: "var(--foreground)", border: "1px solid var(--border)", fontSize: 12 } },
          "Thread list unavailable — showing the last known state",
        )
      : null,
    ),
    createElement(FoundryPane, { state: pane, dispatch, outline, Inspector, Thread, tools, history: edits.history() }),
  );
}
