#!/usr/bin/env node
// Dev loop for the Aleph plugin: runs `bb plugin dev` (rebuild + reload on change) and also
// watches ../desktop/src, which `bb plugin dev` does not (it only watches this folder). The Aleph
// panel bundles the shared pane from there, so a change in either place rebuilds and reloads.
// Usage: npm run dev        (Ctrl+C to stop)
import { spawn } from "node:child_process";
import { utimesSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const shared = join(here, "..", "desktop", "src");
// A file bb already watches; touching it makes bb rebuild the whole bundle.
const nudge = join(here, "src", "panel.ts");

const child = spawn("bb", ["plugin", "dev", here], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));

let timer;
watch(shared, { recursive: true }, (_event, file) => {
  if (!file || /\.test\.|\.d\.ts$/.test(file)) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    const now = new Date();
    utimesSync(nudge, now, now);
    console.log(`desktop/src/${file} changed: asked bb to rebuild`);
  }, 150);
});
console.log(`also watching ${shared}`);
