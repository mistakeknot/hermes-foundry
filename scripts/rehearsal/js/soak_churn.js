// Churn soak: %%N%% scene.update() calls, each changing one card's status (so one creature is rebuilt and the old one disposed).
// Reports update cost, renderer resource counts (geometries/textures/programs are only counted once a frame has drawn them), JS heap,
// label and canvas counts, frame pacing before and after, and whether restoring the original snapshot returns the counts to the start.
const p = await browser.getPage("main");
await p.evaluate(() => { const b = [...document.querySelectorAll("button")].find(x => /no thanks|later/i.test(x.textContent)); b && b.click(); });
const r = await p.evaluate(async (N) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const state = (s) => { const i = s.renderer.info; let objects = 0; s.scene.traverse(() => objects++); const pm = performance.memory || {};
    return {geometries: i.memory.geometries, textures: i.memory.textures, programs: (i.programs || []).length, objects,
      labels: document.querySelectorAll(".foundry-label").length, canvases: document.querySelectorAll("canvas").length, heap_mb: +((pm.usedJSHeapSize || 0) / 1048576).toFixed(1)}; };
  const frames = (secs) => new Promise(res => { const iv = []; let last = performance.now(), t0 = last;
    const f = (t) => { iv.push(t - last); last = t; if (t - t0 < secs * 1000) requestAnimationFrame(f); else { const a = iv.slice(1).sort((x, y) => x - y);
      res({fps: +(1000 * a.length / a.reduce((x, y) => x + y, 0)).toFixed(1), p95_ms: +a[Math.floor(a.length * .95)].toFixed(1), max_ms: +a[a.length - 1].toFixed(1)}); } };
    requestAnimationFrame(f); });
  const q = (a, f) => +a[Math.min(a.length - 1, Math.floor(a.length * f))].toFixed(2);
  const s = window.__foundry.scene, clone = (o) => JSON.parse(JSON.stringify(o));
  const base = clone(s.snap), orig = clone(s.snap), ST = ["open", "running", "review", "done", "blocked"], cards = base.projects.flatMap(c => c.cards);
  await sleep(500);
  const out = {cards: cards.length, start: state(s), frames_before: await frames(3)}, upd = [], marks = [];
  for (let i = 1; i <= N; i++) {
    const c = cards[(i * 7) % cards.length]; c.status = ST[(ST.indexOf(c.status) + 1 + (i % 3)) % ST.length]; c.status_native = c.status === "open" ? "ready" : c.status;
    const t = performance.now(); s.update(clone(base)); upd.push(performance.now() - t);
    if (i % 50 === 0) { await sleep(60); marks.push(Object.assign({i}, state(s))); }
  }
  upd.sort((a, b) => a - b); out.updates = N; out.update_ms = {median: q(upd, .5), p95: q(upd, .95), max: q(upd, 1)}; out.marks = marks; out.frames_after = await frames(3);
  s.update(clone(orig)); await sleep(500); out.after_restore = state(s);
  const un = []; for (let i = 0; i < 100; i++) { const t = performance.now(); s.update(clone(orig)); un.push(performance.now() - t); } un.sort((a, b) => a - b);
  out.unchanged_update_ms = {median: q(un, .5), max: q(un, 1)}; await sleep(500); out.after_unchanged = state(s);
  return out;
}, %%N%%);
JSON.stringify(r)
