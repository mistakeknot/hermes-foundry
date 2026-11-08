import { createElement, useEffect, useMemo, useRef } from "react";
import { experimental_useSidebarThreads } from "@get-bb/plugin-sdk/app";
import foundry from "../../desktop/src/plugin";
import { LiveApi, restFromApi } from "../../desktop/src/live";
import { fromSidebar } from "./from-sidebar";

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

export function FoundryPanel() {
  const sidebar = experimental_useSidebarThreads();
  const api = useRef<LiveApi | null>(null);
  const ready = sidebar.status === "ready";
  const failed = sidebar.status === "error";
  const sidebarRef = useRef(sidebar);
  sidebarRef.current = sidebar;

  if (ready && !api.current) {
    api.current = new LiveApi();
    api.current.update(fromSidebar(sidebar, Date.now()));
  }
  useEffect(() => {
    if (ready && api.current) api.current.update(fromSidebar(sidebar, Date.now()));
  }, [ready, sidebar]);
  useEffect(() => {
    const timer = setInterval(() => {
      const current = sidebarRef.current;
      if (current.status === "ready" && api.current) api.current.update(fromSidebar(current, Date.now()));
    }, CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

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
  // The pane is laid out against this wrapper (position: relative), which sits below the chrome row.
  return createElement(
    "div",
    { style: THEMED },
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
  );
}
