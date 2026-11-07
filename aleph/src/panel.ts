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
    return createElement("div", { style: { padding: 16, opacity: 0.7 } }, message);
  }
  return createElement(
    "div",
    { style: { position: "absolute", inset: 0, minHeight: 0 } },
    page as never,
    // After the first data, a later failure keeps the last board but says it may be out of date.
    failed
      ? createElement(
          "div",
          { style: { position: "absolute", left: 8, top: 8, padding: "4px 8px", borderRadius: 6, background: "rgba(0,0,0,0.7)", color: "#fff", fontSize: 12 } },
          "Thread list unavailable — showing the last known state",
        )
      : null,
  );
}
