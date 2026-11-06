// Stage "goto": consume the one-use link. Stage "optin": merge decisions (never overwrite) and reload.
const p = await browser.getPage("main");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stage = %%STAGE%%;
let out;
if (stage === "goto") {
  await p.goto(%%URL%%, {waitUntil: "domcontentloaded", timeout: 60000}).catch(e => 0);
  await sleep(3000);
  out = JSON.stringify({ok: true});
} else {
  const enable = %%ENABLE%%;
  const dec = await p.evaluate((enable) => {
    const k = "hermes.desktop.pluginDecisions.v2";
    const d = JSON.parse(localStorage.getItem(k) || "{}");
    for (const n of enable) d[n] = true;
    localStorage.setItem(k, JSON.stringify(d));
    return d;
  }, enable);
  await p.reload({waitUntil: "domcontentloaded", timeout: 60000}).catch(e => 0);
  await sleep(4000);
  out = JSON.stringify({dec});
}
out
