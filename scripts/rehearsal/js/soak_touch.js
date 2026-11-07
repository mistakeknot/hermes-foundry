// Touch input through the browser's touchscreen API: taps on three cards, a one-finger drag on empty ground (orbit), and a two-finger spread (pinch).
const p = await browser.getPage("main");
await p.evaluate(() => { const b = [...document.querySelectorAll("button")].find(x => /no thanks|later/i.test(x.textContent)); b && b.click(); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const info = () => p.evaluate(() => { const s = window.__foundry.scene; return {cam: s.camera.position.toArray().map(x => +x.toFixed(2)), dist: +s.camera.position.distanceTo(s.controls.target).toFixed(2), sel: s.selectedCard || null}; });
// Screen positions of cards that a click would hit, and a piece of empty ground, from the camera as it is right now (selecting a card can move the camera).
const targets = () => p.evaluate(() => { const s = window.__foundry.scene, cv = document.querySelector("canvas"), r = cv.getBoundingClientRect(), cards = [];
  for (const c of s.snap.projects.flatMap(q => q.cards)) { const w = s.cardWorldPos(c.id); if (!w) continue; const v = w.clone().project(s.camera); if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1) continue;
    const h = s.pickAt(new v.constructor(v.x, v.y)); if (!h || h.pick.kind !== "card" || h.pick.id !== c.id) continue; cards.push({id: c.id, x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height}); }
  let empty = null;
  for (const [fx, fy] of [[.1,.5],[.9,.5],[.5,.1],[.5,.9],[.15,.15],[.85,.85]]) { const x = r.left + fx * r.width, y = r.top + fy * r.height;
    if (!s.pickAt(new (s.camera.position.constructor)(fx * 2 - 1, -(fy * 2 - 1), 0))) { empty = {x, y}; break; } }
  return {cards, empty, touch_action: getComputedStyle(cv).touchAction}; });
const first = await targets();
const out = {touch_action: first.touch_action, taps: [], tap_targets: first.cards.length}, tapped = new Set();
for (let i = 0; i < 3; i++) {
  const c = (await targets()).cards.find(x => !tapped.has(x.id)); if (!c) break; tapped.add(c.id);
  await p.touchscreen.tap(c.x, c.y); await sleep(800);
  out.taps.push({want: c.id, selected: await p.evaluate(() => window.__foundry.scene.selectedCard), panel: await p.evaluate(() => { const e = document.getElementById("foundry-panel"); return !!e && e.innerText.length > 0; })});
}
const t = await targets();
if (t.empty) {
  const a0 = await info(); out.before = a0;
  try { const h = await p.touchscreen.touchStart(t.empty.x, t.empty.y); for (let i = 1; i <= 8; i++) { await h.move(t.empty.x + i * 15, t.empty.y + i * 4); await sleep(30); } await h.end();
    out.orbit = await info(); out.orbit_moved = JSON.stringify(a0.cam) !== JSON.stringify(out.orbit.cam); } catch (e) { out.orbit_err = String(e).slice(0, 200); }
  try { const a = await p.touchscreen.touchStart(t.empty.x - 40, t.empty.y), b = await p.touchscreen.touchStart(t.empty.x + 40, t.empty.y);
    for (let i = 1; i <= 8; i++) { await a.move(t.empty.x - 40 - i * 12, t.empty.y); await b.move(t.empty.x + 40 + i * 12, t.empty.y); await sleep(30); } await a.end(); await b.end();
    const pr = await info(); out.pinch = pr; out.pinch_dist_changed = pr.dist !== (out.orbit || a0).dist; out.selection_kept_after_pinch = pr.sel === (out.orbit || a0).sel; } catch (e) { out.pinch_err = String(e).slice(0, 200); }
} else out.empty_err = "no empty ground found to drag on";
JSON.stringify(out)
