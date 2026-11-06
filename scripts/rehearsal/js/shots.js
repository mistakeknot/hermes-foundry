// Art-audit screenshots of the pane. View: "valley" (default camera), "creature" (focus the first project),
// "blocked" or "done" (camera close to the first card with that display status). One screenshot per call.
const p = await browser.getPage("main");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const view = %%VIEW%%;
await p.evaluate(() => { const b = [...document.querySelectorAll("button")].find(x => /no thanks|later/i.test(x.textContent)); b && b.click(); });
const info = await p.evaluate((view) => {
  const s = window.__foundry.scene, cards = s.snap.projects.flatMap(q => q.cards);
  const count = {}; for (const c of cards) count[c.status] = (count[c.status] || 0) + 1;
  let note = "";
  if (view === "creature") { if (!s.snap.projects.length) return {missing: true, note: "no project", count}; s.focusCreature(s.snap.projects[0].id); note = "focus " + s.snap.projects[0].name; }
  else if (view === "blocked" || view === "done" || view === "review") {
    const c = cards.find(c => c.status === view);
    if (!c) return {missing: true, note: "no " + view + " card", count};
    const w = s.cardWorldPos(c.id), out = new w.constructor(w.x, 0, w.z).normalize();   // away from the world centre, a little above the card
    s.controls.target.copy(w); s.camera.position.copy(w.clone().add(out.multiplyScalar(9)).add(new w.constructor(0, 5, 0))); s.controls.update(); note = view + " card " + c.title;
  }
  return {note, count, projects: s.snap.projects.length, cards: cards.length, mode: s.snap.mode, size: [innerWidth, innerHeight]};
}, view);
if (info.missing) throw new Error("shots target missing: " + JSON.stringify(info));   // no screenshot is taken; the harness fails the run
await sleep(2500);
await p.shot({type: "jpeg", maxEdge: 1100, quality: 72});
JSON.stringify(info)
