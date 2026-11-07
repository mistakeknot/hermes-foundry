# Foundry for Aleph (bb plugin)

The same 3D board as the Hermes plugin, drawn from your bb projects and threads. **Read-only.**

| bb | Foundry |
| --- | --- |
| project | board |
| sidebar section | epic (a lane on its board) |
| thread | card |
| thread that is working | climber on its own card |

It reuses the shared pane unchanged (`desktop/src/scene.ts`, `reducer.ts`, `types.ts`, `framing.ts`, `page.ts`). The only new
shared file is `desktop/src/live.ts`, which turns a list of projects, sections and threads into the Foundry contract
(snapshot plus events). Aleph feeds it from `experimental_useSidebarThreads()`.

## What a card's status means

A thread has no "done" of its own, so the status is a reading, in this order:

1. waiting for a person (a question or approval pending) → **blocked** (on a human), shown as a waiting climber
2. execution status `error` → **blocked** (no owner)
3. `active`, `starting`, `pending` or `stopping` → **running**, with a climber
4. unread finished work → **review**
5. idle and untouched for more than 24 hours → **done**
6. anything else → **open**

Archived and hidden threads are not drawn, and a project with no drawn thread has no board. At most 240 cards are drawn;
working and waiting threads are taken first, then the most recently touched.

## Command buttons

The pane's command buttons (pause, reset and the like) answer with a read-only error: *"Foundry is read-only here: it shows
threads but does not act on them yet."* Nothing is sent to any thread.

## Build and test

```
cd aleph
npm install
npm run typecheck
npm test
npm run build      # writes dist/ (bb plugin build)
```

`dist/` and `node_modules/` are not tracked.

## Install

Installing changes the running bb, so do it on purpose, not from a script. `bb plugin install` accepts a local path, so build
first, then install the `aleph/` folder:

```
cd aleph && npm install && npm run build
bb plugin install /path/to/aleph
bb plugin list            # shows the plugin id
```

A local path source stays on disk and can be re-read with `bb plugin reload <id>` after a rebuild (or `bb plugin dev` while
editing), so a restart should not be needed; this was read from `bb plugin --help` and has not been tried here. To turn it off,
use `bb plugin disable <id>`; to remove it, `bb plugin uninstall <id>` (this deletes the plugin's settings, and leaves the
folder on disk).

## Why the Hermes plugin is untouched

The Hermes bundle `desktop/plugin.js` must stay byte-identical until the entry is submitted, so `src/plugin.ts` and its import
graph are unchanged. Aleph drives that same plugin through a small fake `register` context (`aleph/src/panel.ts`), and the
Hermes SDK import is resolved to a tiny shim (`desktop/src/hermes-sdk-shim.ts`) for type-checking and for Aleph's bundler
only; the Hermes build still leaves it external.

## What remains

- Split the host-specific part out of `src/plugin.ts` into a host-neutral core, once a changed Hermes bundle is allowed.
- Show the pane's own loading and error states instead of the panel's placeholder.
- Run it in a live Aleph and take a screenshot (not measured yet), including layout and fit in the nav panel.
- Check that `experimental_useSidebarThreads` exists in the oldest Aleph that should be supported (the embedded SDK there
  is older than the one this plugin builds against).
- Actions (open a thread from a card, start or stop work) are deliberately not built.
