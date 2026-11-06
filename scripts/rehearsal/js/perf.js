// Frame pacing of the pane: rAF intervals for SECONDS s idle, then while the camera auto-orbits; plus draw-call counts and pick latency.
const p = await browser.getPage("main");
await p.evaluate(() => { const b = [...document.querySelectorAll("button")].find(x => /no thanks|later/i.test(x.textContent)); b && b.click(); });
const r = await p.evaluate(async (secs) => {
  const s = window.__foundry.scene;
  const stats = (iv) => { const a = iv.slice().sort((x, y) => x - y), n = a.length, sum = a.reduce((x, y) => x + y, 0);
    return {frames: n, fps_mean: +(1000 * n / sum).toFixed(1), ms_median: +a[n >> 1].toFixed(1), ms_p95: +a[Math.floor(n * 0.95)].toFixed(1), ms_max: +a[n - 1].toFixed(1), over_50ms: a.filter(x => x > 50).length}; };
  const measure = () => new Promise(res => { const iv = []; let last = performance.now(), t0 = last;
    const f = (t) => { iv.push(t - last); last = t; if (t - t0 < secs * 1000) requestAnimationFrame(f); else res(stats(iv.slice(1))); }; requestAnimationFrame(f); });
  const idle = await measure();
  s.controls.autoRotate = true; s.controls.autoRotateSpeed = 6;
  const orbit = await measure();
  s.controls.autoRotate = false;
  const cv = document.querySelector("canvas"), gl = cv.getContext("webgl2") || cv.getContext("webgl");
  const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
  const info = s.renderer.info;
  const NDC = new (s.camera.position.constructor)(0, 0, 0).constructor;
  const t0 = performance.now(); let n = 0; for (let i = 0; i < 40; i++) { const v = new NDC(((i * 37) % 100) / 50 - 1, ((i * 53) % 100) / 50 - 1, 0); s.pickAt(v); n++; }
  const cards = s.snap.projects.reduce((k, q) => k + q.cards.length, 0);
  return {cards, projects: s.snap.projects.length, creatures: s.creatures.size, idle, orbit,
    draw_calls: info.render.calls, triangles: info.render.triangles, geometries: info.memory.geometries, textures: info.memory.textures,
    gl: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null, pick_ms: +((performance.now() - t0) / n).toFixed(2), viewport: [innerWidth, innerHeight], dpr: devicePixelRatio};
}, %%SECONDS%%);
JSON.stringify(r)
