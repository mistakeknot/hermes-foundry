import { buildLiveShape, type LiveOptions } from "../../desktop/src/live";
import { fromSidebar, type SidebarStateLike } from "./from-sidebar";

// What the pane can have selected. Creature = a bb project, limb = a sidebar section of that project, and `sectionId: null`
// is the "Unsorted" limb (the project's threads that are in no section). A card (thread) is not selectable here: the thread
// area is the conversation, not an item.
export type Selection =
  | { kind: "creature"; projectId: string }
  | { kind: "limb"; projectId: string; sectionId: string | null };

export const UNSORTED = "Unsorted";

export interface OutlineLimb { sectionId: string | null; name: string; threadIds: string[] }
export interface OutlineCreature { projectId: string; name: string; threadIds: string[]; limbs: OutlineLimb[] }

/** What is attached to the thread when something is selected. */
export interface SelectionContext {
  kind: Selection["kind"];
  projectId: string;
  projectName: string;
  sectionId: string | null;
  sectionName: string | null;
  /** The cards (threads) the selection covers: the whole project for a creature, one section for a limb. */
  threadIds: string[];
  /** Short human label, e.g. "Alpha" or "Alpha › Docs". */
  label: string;
}

export function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind || a.projectId !== b.projectId) return false;
  return a.kind === "creature" || (b.kind === "limb" && a.sectionId === b.sectionId);
}

/** Choosing what is already chosen closes the drawer; anything else replaces the selection. */
export function toggleSelection(current: Selection | null, next: Selection): Selection | null {
  return sameSelection(current, next) ? null : next;
}

/**
 * The creatures and limbs that exist right now. This is derived from the board itself: it runs the board's own
 * `buildLiveShape` (the same archived/hidden/unknown-project filter and the same card cap, working and waiting threads
 * first) over the same sidebar state, so the picker can never offer a creature, limb or card the board does not draw.
 * A creature exists when its board has a card; a limb exists when a drawn card is in that section; "Unsorted" exists when
 * a drawn card is in no known section. Creatures and cards keep the sidebar's order, limbs the sidebar's section order,
 * Unsorted last. `opts` must match what the board's `LiveApi` was built with (the panel uses the defaults).
 */
export function buildOutline(s: SidebarStateLike, opts: LiveOptions = {}): OutlineCreature[] {
  const shape = buildLiveShape(fromSidebar(s, 0), opts);
  const drawn = new Map<string, Map<string, string | null>>(); // project id -> thread id -> section id (null = Unsorted)
  for (const p of shape.projects) {
    const prefix = `${p.id}:`;
    drawn.set(p.id, new Map(p.cards.map((c) => [c.id.slice(prefix.length), c.epic_id])));
  }
  const order = new Map(s.sections.map((x, i) => [x.id, { name: x.name, order: i }]));
  const out: OutlineCreature[] = [];
  for (const p of s.projects) {
    const cards = drawn.get(p.id);
    if (!cards) continue;
    const mine = s.threads.filter((t) => t.projectId === p.id && cards.has(t.id));
    const bySection = new Map<string | null, string[]>();
    for (const t of mine) {
      const key = cards.get(t.id) ?? null;
      (bySection.get(key) ?? bySection.set(key, []).get(key)!).push(t.id);
    }
    const limbs: OutlineLimb[] = [...bySection.entries()]
      .filter(([k]) => k !== null)
      .sort((a, b) => order.get(a[0]!)!.order - order.get(b[0]!)!.order)
      .map(([k, ids]) => ({ sectionId: k, name: order.get(k!)!.name, threadIds: ids }));
    const unsorted = bySection.get(null);
    if (unsorted) limbs.push({ sectionId: null, name: UNSORTED, threadIds: unsorted });
    out.push({ projectId: p.id, name: p.name, threadIds: mine.map((t) => t.id), limbs });
  }
  return out;
}

/** The context for a selection, or null if what it names is gone (project removed, or the section has no drawn thread). */
export function contextFor(sel: Selection | null, outline: readonly OutlineCreature[]): SelectionContext | null {
  if (!sel) return null;
  const creature = outline.find((c) => c.projectId === sel.projectId);
  if (!creature) return null;
  if (sel.kind === "creature") {
    return { kind: "creature", projectId: creature.projectId, projectName: creature.name, sectionId: null, sectionName: null, threadIds: creature.threadIds, label: creature.name };
  }
  const limb = creature.limbs.find((l) => l.sectionId === sel.sectionId);
  if (!limb) return null;
  return { kind: "limb", projectId: creature.projectId, projectName: creature.name, sectionId: limb.sectionId, sectionName: limb.name, threadIds: limb.threadIds, label: `${creature.name} › ${limb.name}` };
}
