import { createElement, useEffect, useMemo, useRef } from "react";
import { experimental_useSidebarThreads } from "@get-bb/plugin-sdk/app";
import foundry from "../../desktop/src/plugin";
import { LiveApi, restFromApi } from "../../desktop/src/live";
import { fromSidebar } from "./from-sidebar";

// The pane is the unchanged Hermes one. It is mounted by running the Hermes plugin's own `register` against a small
// context: `register` hands back the page's render function, and `rest` is served from the live thread list instead of
// a Hermes HTTP router. Nothing is copied or forked, so a fix to the pane lands in both hosts.
export function FoundryPanel() {
  const sidebar = experimental_useSidebarThreads();
  const api = useRef<LiveApi | null>(null);
  const ready = sidebar.status === "ready";
  const failed = sidebar.status === "error";

  if (ready && !api.current) {
    api.current = new LiveApi();
    api.current.update(fromSidebar(sidebar, Date.now()));
  }
  useEffect(() => {
    if (ready && api.current) api.current.update(fromSidebar(sidebar, Date.now()));
  }, [ready, sidebar]);

  const page = useMemo(() => {
    if (!ready && !failed) return null;
    let render: (() => unknown) | null = null;
    foundry.register({
      rest: restFromApi(() => api.current),
      register: (c: { id: string; render?: () => unknown }) => {
        if (c.id === "page") render = c.render ?? null;
      },
    } as never);
    return render ? (render as () => unknown)() : null;
    // The pane reads its transport once when it mounts, so mount it once, after the first data (or the failure).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready || failed]);

  if (!page) return createElement("div", { style: { padding: 16, opacity: 0.7 } }, "Loading threads…");
  return createElement("div", { style: { position: "absolute", inset: 0, minHeight: 0 } }, page as never);
}
