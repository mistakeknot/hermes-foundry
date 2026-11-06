// One timed trial: open a card, set its status, assign a profile -- in the pane ("pane") or the 2D board ("board").
// "floor" measures the harness round-trip cost. Real mouse/keyboard events; wall time from the first input to the UI showing the result.
// Params: STAGE, TRIAL (0-based, picks the card), STATUS (todo|done|blocked), PROFILE.
const p = await browser.getPage("main");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stage = %%STAGE%%, trial = %%TRIAL%%, status = %%STATUS%%, profile = %%PROFILE%%;
const now = () => Date.now();
const until = (body, arg, to = 8000) => p.evaluate(async (body, arg, to) => {
  const f = new Function("a", body); const t0 = performance.now();
  for (;;) { try { if (f(arg)) return true; } catch (e) {} if (performance.now() - t0 > to) return false; await new Promise(r => setTimeout(r, 4)); }
}, body, arg, to);
const dismiss = () => p.evaluate(() => { const b = [...document.querySelectorAll("button")].find(x => /no thanks|later/i.test(x.textContent)); if (b) b.click(); });
const click = async (pt, why = "") => {
  if (!pt) { const d = await p.evaluate(() => { const g = document.querySelector('[role="dialog"]'); return {dialog: g ? g.innerText.slice(0, 200) : null, menu: [...document.querySelectorAll('[role^="menuitem"]')].map(x => x.innerText.trim()).slice(0, 8), url: location.href}; }); throw new Error("no click target (" + why + "): " + JSON.stringify(d)); }
  await p.mouse.click(pt.x, pt.y);
};
const steps = []; const cost = {clicks: 0, keys: 0};
const mark = () => ({c: cost.clicks, k: cost.keys});
let out;
if (stage === "floor") {
  const ev = []; for (let i = 0; i < 15; i++) { const t = now(); await p.evaluate(() => 1); ev.push(now() - t); }
  const mc = []; for (let i = 0; i < 8; i++) { const t = now(); await p.mouse.click(5, 5); mc.push(now() - t); }
  const med = a => a.slice().sort((x, y) => x - y)[a.length >> 1];
  out = JSON.stringify({eval_ms: med(ev), click_ms: med(mc)});
} else if (stage === "pane") {
  await dismiss();
  const cand = await p.evaluate(() => {
    const s = window.__foundry.scene, cv = document.querySelector("canvas"), r = cv.getBoundingClientRect(); const res = [];
    for (const c of s.snap.projects.flatMap(q => q.cards)) {
      if (c.status_native === "running" || c.assignee_profile) continue;
      const w = s.cardWorldPos(c.id); if (!w) continue; const v = w.clone().project(s.camera);
      if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1) continue;
      const h = s.pickAt(new v.constructor(v.x, v.y)); if (!h || h.pick.kind !== "card" || h.pick.id !== c.id) continue;
      res.push({id: c.id, title: c.title, x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height});
    } return res;
  });
  const card = cand[0];   // cards already used in earlier trials are assigned now, so the first candidate is a fresh one
  // 1. open the card: click its scale in the 3D scene
  let t0 = now(); await click(card, "pane card"); cost.clicks++;
  const okOpen = await until("return !!document.getElementById('foundry-status') && document.getElementById('foundry-panel').innerText.includes(a)", card.title);
  steps.push({step: "open", ms: now() - t0, clicks: 1, keys: 0, ok: okOpen});
  // 2. change status: focus the select, type the first letter of the option, Enter, press Set status
  let m = mark(); t0 = now(); let method = "keyboard";
  const sel = await p.evaluate(() => { const r = document.getElementById("foundry-status").getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; });
  await click(sel); cost.clicks++;
  await p.keyboard.type(status[0]); cost.keys++;
  await p.keyboard.press("Enter"); cost.keys++;
  let got = await p.evaluate(() => document.getElementById("foundry-status").value);
  if (got !== status) {            // the native select popup swallowed the keys: set the value the way an input event would, count one action
    method = "setter";
    await p.evaluate((v) => { const s = document.getElementById("foundry-status"); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, v); s.dispatchEvent(new Event("change", {bubbles: true})); }, status);
  }
  const ap = await p.evaluate(() => { const r = document.getElementById("foundry-status-apply").getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; });
  await click(ap); cost.clicks++;
  const ackS = await until("return (document.getElementById('foundry-notice')||{innerText:''}).innerText.includes('Moved to '+a)", status);
  const tAck = now() - t0;
  const noteS = await p.evaluate(() => (document.getElementById("foundry-notice") || {}).innerText || "");
  const refS = await until("const s=window.__foundry.scene; const c=s.snap.projects.flatMap(q=>q.cards).find(c=>c.id===a.id); return c&&c.status_native===a.s", {id: card.id, s: status}, 15000);
  steps.push({step: "status", ms: tAck, ms_scene: now() - t0, clicks: cost.clicks - m.c, keys: cost.keys - m.k, ok: ackS, scene_ok: refS, select_method: method, notice: noteS});
  // 3. assign a profile: click the input, type the name, press Assign
  m = mark(); t0 = now();
  const inp = await p.evaluate(() => { const r = document.getElementById("foundry-profile").getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; });
  await click(inp); cost.clicks++;
  await p.keyboard.type(profile); cost.keys += profile.length;
  const as = await p.evaluate(() => { const r = document.getElementById("foundry-assign").getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; });
  await click(as); cost.clicks++;
  const ackA = await until("return (document.getElementById('foundry-notice')||{innerText:''}).innerText.includes('Assigned to '+a)", profile);
  const tAckA = now() - t0;
  const noteA = await p.evaluate(() => (document.getElementById("foundry-notice") || {}).innerText || "");
  const refA = await until("const s=window.__foundry.scene; const c=s.snap.projects.flatMap(q=>q.cards).find(c=>c.id===a.id); return c&&c.assignee_profile===a.p", {id: card.id, p: profile}, 15000);
  steps.push({step: "assign", ms: tAckA, ms_scene: now() - t0, clicks: cost.clicks - m.c, keys: cost.keys - m.k, ok: ackA, scene_ok: refA, notice: noteA});
  await p.shot({type: "jpeg", maxEdge: 1100, quality: 70});
  out = JSON.stringify({ui: "pane", card: card.title, id: card.id, candidates: cand.length, steps});
} else {
  await dismiss(); await sleep(1200);
  await until("return document.querySelectorAll('[draggable=true]').length>0", 0, 10000);
  const lab = {todo: "Todo", done: "Done", blocked: "Blocked"}[status];
  const cardAt = await p.evaluate((trial) => {
    // unassigned cards (the board labels them "won't run") whose whole card is in view: the best case for the board
    const vis = [...document.querySelectorAll('[draggable="true"]')].filter(e => { const r = e.getBoundingClientRect(); return r.bottom < innerHeight - 8 && r.top > 0 && /won't run/.test(e.innerText); });
    const e = vis[0]; const r = e.getBoundingClientRect();
    return {title: e.innerText.split("\n")[0], x: r.x + r.width / 2, y: r.y + r.height / 2, visible: vis.length};
  }, trial);
  const drawerBtn = async (txtRe) => { await until("const d=document.querySelector('[role=dialog]'); return !!d && [...d.querySelectorAll('button')].some(b=>new RegExp(a,'i').test(b.innerText.trim()))", txtRe, 6000); return drawerBtn0(txtRe); };
  const drawerBtn0 = (txtRe) => p.evaluate((re) => { const d = document.querySelector('[role="dialog"]'); const b = d && [...d.querySelectorAll("button")].find(x => new RegExp(re, "i").test(x.innerText.trim())); if (!b) return null; const r = b.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; }, txtRe);
  const menuItem = (txt) => p.evaluate((txt) => { const i = [...document.querySelectorAll('[role="menuitem"],[role="menuitemradio"]')].find(x => x.innerText.trim().toLowerCase().endsWith(txt.toLowerCase())); if (!i) return null; const r = i.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; }, txt);
  // 1. open: click the card
  let t0 = now(); await click(cardAt, "board card"); cost.clicks++;
  const okOpen = await until("const d=document.querySelector('[role=dialog]'); return !!d && d.innerText.includes(a)", cardAt.title);
  steps.push({step: "open", ms: now() - t0, clicks: 1, keys: 0, ok: okOpen});
  // 2. status: trigger (shows the current status) then the menu item
  let m = mark(); t0 = now();
  const trig = await drawerBtn("^(triage|todo|ready|running|blocked|review|done|scheduled)$");
  await click(trig, "status trigger"); cost.clicks++;
  await until("return [...document.querySelectorAll('[role=menuitem],[role=menuitemradio]')].length>0", 0, 3000);
  const it = await menuItem(lab); await click(it, "status item " + lab); cost.clicks++;
  const okS = await until("const d=document.querySelector('[role=dialog]'); return !!d && [...d.querySelectorAll('button')].some(b=>b.innerText.trim().toLowerCase()===a)", status.toLowerCase());
  steps.push({step: "status", ms: now() - t0, clicks: cost.clicks - m.c, keys: 0, ok: okS});
  // 3. assign: trigger (shows "unassigned") then the profile item
  m = mark(); t0 = now();
  const at = await drawerBtn("^unassigned$");
  await click(at, "assignee trigger"); cost.clicks++;
  await until("return [...document.querySelectorAll('[role=menuitem],[role=menuitemradio]')].length>0", 0, 3000);
  const pi = await menuItem(profile); await click(pi, "assignee item " + profile); cost.clicks++;
  const okA = await until("const d=document.querySelector('[role=dialog]'); return !!d && [...d.querySelectorAll('button')].some(b=>b.innerText.trim().toLowerCase().split('\\n').pop()===a)", profile.toLowerCase());
  steps.push({step: "assign", ms: now() - t0, clicks: cost.clicks - m.c, keys: 0, ok: okA});
  await p.shot({type: "jpeg", maxEdge: 1100, quality: 70});
  await p.keyboard.press("Escape"); await sleep(500);   // back to browsing: not part of the three timed actions
  out = JSON.stringify({ui: "board", card: cardAt.title, visible_cards: cardAt.visible, steps, close_drawer: {keys: 1}});
}
out
