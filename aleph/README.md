# Foundry for Aleph (bb plugin)

The same 3D board as the Hermes plugin, drawn from your bb projects and threads. The board is read-only; the pane's chat and inspector make small edits (rename a section, move a thread, pick or re-roll a look), each with Undo.

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

The pane's picker uses the same filter and the same cap. `buildOutline` (`src/selection.ts`) does not filter threads itself:
it runs the board's own `buildLiveShape` over the same sidebar state and reads the creatures, limbs and cards from that
result. So the picker never offers a creature, limb or card the board does not draw (no "Omitted" limb, no card without a
board counterpart), and a project whose threads are all archived, hidden or past the cap has no creature, as it has no
board. Tests with more than 240 threads, and a check that the outline and the board hold the same cards, guard this.

## Command buttons

The pane's command buttons (pause, reset and the like) answer with a read-only error: *"Foundry is read-only here: it shows
threads but does not act on them yet."* Nothing is sent to any thread.

## The Foundry chat

The pane's thread area is bb's own chat for one Foundry thread, shown under the selection chip and the edit history. On first
open the plugin tries to create a bb project named **Foundry** that points at an empty folder under the plugin's data
directory, and to spawn one visible thread in it, marked `chat: true` so the `foundry_*` edit tools attach to it. The ids are
saved in `chat.json` in that directory. Before creating anything it looks for a project named Foundry on that folder and a
live thread titled Foundry in it, so a lost write or reply reuses what an earlier attempt made. If either is deleted or
archived the next open makes a new one, and any other failure is shown in the pane and creates nothing. This is checked
within one plugin process only; two processes asking at the same moment could still each create one. The Foundry project and
its thread are left out of the board and the picker once the plugin has looked the project up.

Not verified against a live bb yet: that a plugin may create a project, that bb accepts an empty folder that is not a git
repository, that a thread in it starts with the Foundry tools attached, and which provider, model and permission mode the
thread gets. The folder is empty, but that does not limit the thread to the Foundry tools: bb's own tools and approval
settings apply to it as to any thread. There is no manual fallback in the plugin; a project added by hand is only picked up
if it is named Foundry and points at the plugin's `chat-workspace` folder.

## The Foundry pane (right-hand side)

The panel is a row: the board on the left, the Foundry pane on the right (22% of the width, 260 to 420 px). The pane is a
stacked column: a picker row (creatures, then the chosen creature's limbs), the thread filling the rest, and an inspector
drawer at the bottom that opens when a creature or limb is selected and closes on the same choice again or on ✕.

| Foundry | bb |
| --- | --- |
| creature | project |
| limb | sidebar section (plus **Unsorted**: threads in no section) |
| card | thread |

A selection is attached to the thread as context (`Context: Alpha › Docs`), and a form edit shows in the thread as a line.
The pane follows bb's theme through its CSS variables and never writes to bb: its lines live in the plugin only.

Two seams are left for later beads, both in `src/thread-port.ts`: `ThreadComponent` (the real Foundry thread replaces
`PlaceholderThread`) and `InspectorComponent` (the lineage, name and section forms replace `PlaceholderInspector`; the form
calls `onEdit(text)` to record an edit). Selection is made in the picker for now: the board's own click selection lives
inside the shared Hermes pane and is not exported, and exporting it needs a change under `desktop/src`.

Layout: `src/layout.ts`. Selection and the outline: `src/selection.ts`. Pane state: `src/pane-state.ts`. The pane: `src/pane.ts`.

## Sections

`src/sections/` holds the host-agnostic sections interface (list, create, rename, remove sections; move a card between
them; per project), an in-memory backend, the Hermes backend (a Foundry file per board beside the kanban) and the bb
backend (bb's own thread sections, scoped to a project by a name prefix). Any backend must pass the contract suite in
`test/sections/contract.ts`. See [`docs/sections-file.md`](../docs/sections-file.md) and
[`docs/sections-bb.md`](../docs/sections-bb.md). Nothing in the panel's UI uses them yet; the panel only installs a console
check, `__foundryBbSectionsCheck()`, that exercises the bb backend against the real SDK.

## Build and test

```
(cd desktop && npm install)   # the type-check needs the pane's own dependencies (three)
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

A local path source stays on disk and can be re-read with `bb plugin reload <id>` after a rebuild, so a restart is not needed.

### Dev loop (rebuild and reload on save)

```
cd aleph && npm run dev
```

This runs `bb plugin dev` and also watches `../desktop/src`, the shared pane the panel bundles; `bb plugin dev` alone watches
only `aleph/`, so a change to the pane would not rebuild. A save in either place rebuilds the bundle (about 0.3 s) and reloads
the plugin in the running bb. Dev builds are unminified; run `npm run build` afterwards to restore the release bundle. To turn it off,
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
- The plugin declares `bbPluginSdk >=0.6.100` because it imports only `definePluginApp` and `experimental_useSidebarThreads`,
  which the built-in plugins of a 0.6.100 host already use. Found on a live host: the first declared floor (0.6.132, the
  build-time SDK) made a 0.6.100 host mark the plugin incompatible. Not yet checked: anything older than 0.6.100.
- Actions (open a thread from a card, start or stop work) are deliberately not built.
