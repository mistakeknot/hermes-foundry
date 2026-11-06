// Stages: "goto" (reload), "probe" (dismiss onboarding, report readiness), "shot" (final info + screenshot).
const p = await browser.getPage("main");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stage = %%STAGE%%;
const info = () => p.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find(x => /no thanks|later/i.test(x.textContent)); b && b.click();
  const s = window.__foundry && window.__foundry.scene;
  return {
    nav: [...document.querySelectorAll("a,button")].some(x => x.textContent.trim() === "Foundry"),
    has: !!s, creatures: s && s.creatures ? s.creatures.size : 0,
    cards: s && s.snap ? s.snap.projects.reduce((n, q) => n + q.cards.length, 0) : 0,
    mode: s && s.snap ? s.snap.mode : null, simulated: !!document.getElementById("foundry-simulated"),
  };
});
let out;
if (stage === "goto") {
  // A direct URL lands on the home page (plugin routes register after load); the sidebar row is the way in.
  await p.reload({waitUntil: "domcontentloaded", timeout: 60000}).catch(e => 0);
  out = JSON.stringify({ok: true});
} else if (stage === "probe") {
  await sleep(3000);
  await p.evaluate(() => { if (!window.__foundry) { const e = [...document.querySelectorAll("a,button")].find(x => x.textContent.trim() === "Foundry"); e && e.click(); } });
  await sleep(2000);
  out = JSON.stringify(await info());
} else {
  await sleep(1500);
  const r = await info();
  await p.shot({type: "jpeg", maxEdge: 1100, quality: 70});
  out = JSON.stringify(r);
}
out
