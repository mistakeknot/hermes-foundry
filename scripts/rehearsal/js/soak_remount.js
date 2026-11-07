// One remount step. STAGE "away": leave /foundry through a sidebar row (the old scene is kept in window.__oldScene to inspect it);
// "mid": what is left in the page; "back": return through the Foundry row; "probe": the new scene's counts.
const p = await browser.getPage("main");
const stage = %%STAGE%%;
let out;
if (stage === "away") {
  out = await p.evaluate(() => { window.__oldScene = window.__foundry.scene;
    const a = [...document.querySelectorAll("a,button")].find(x => /^(artifacts|capabilities|messaging)$/i.test(x.textContent.trim())); a && a.click(); return {clicked: a ? a.textContent.trim() : null}; });
} else if (stage === "mid") {
  out = await p.evaluate(() => ({canvases: document.querySelectorAll("canvas").length, labels: document.querySelectorAll(".foundry-label").length, old_disposed: !!(window.__oldScene && window.__oldScene.disposed),
    old_context_lost: (() => { try { return window.__oldScene.renderer.getContext().isContextLost(); } catch (e) { return "err"; } })()}));
} else if (stage === "back") {
  out = await p.evaluate(() => { const e = [...document.querySelectorAll("a,button")].find(x => x.textContent.trim() === "Foundry"); e && e.click(); return {clicked: !!e}; });
} else {
  out = await p.evaluate(() => { const s = window.__foundry && window.__foundry.scene, pm = performance.memory || {};
    return {has: !!s, new_scene: !!s && s !== window.__oldScene, disposed: s ? !!s.disposed : null, canvases: document.querySelectorAll("canvas").length, labels: document.querySelectorAll(".foundry-label").length,
      geometries: s ? s.renderer.info.memory.geometries : null, heap_mb: +((pm.usedJSHeapSize || 0) / 1048576).toFixed(1)}; });
}
JSON.stringify(out)
