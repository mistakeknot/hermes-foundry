// Open the 2D Hermes kanban board from the sidebar (the same Webapp, the same page, the same browser).
const p = await browser.getPage("main");
const sleep = ms => new Promise(r => setTimeout(r, ms));
await p.evaluate(() => { const b = [...document.querySelectorAll("button")].find(x => /no thanks|later/i.test(x.textContent)); b && b.click(); });
await p.evaluate(() => { const e = [...document.querySelectorAll("a,button")].find(x => x.textContent.trim() === "Kanban"); e && e.click(); });
await sleep(3000);
JSON.stringify(await p.evaluate(() => ({cards: document.querySelectorAll('[draggable="true"]').length})))
