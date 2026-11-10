// An AI suggestion is a pill showing the answer: clicking the pill writes it into the box, and nothing is written before that.
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'af-profile-')), {
  channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const html = `<!doctype html><title>Form</title><main><form>
<div role=listitem><div id=q1>What's your full name?</div><input id=a aria-labelledby=q1></div>
<div role=listitem><div id=q2>What's your email?</div><input id=c type=email aria-labelledby=q2></div>
<div role=listitem><div id=q3>What's your phone number?</div><input id=d aria-labelledby=q3></div>
<div role=listitem><div id=q5>Message for the hiring team</div><textarea id=m aria-labelledby=q5></textarea></div>
<div role=listitem><div id=q6>What is your best achievement till date?</div><input id=b6 type=text aria-labelledby=q6></div></form></main>`;
await ctx.route('https://docs.google.com/forms/**', (r) => r.fulfill({ contentType: 'text/html', body: html }));
const p = await ctx.newPage();
await p.setViewportSize({ width: 1300, height: 900 });
const t0 = Date.now();
await p.goto('https://docs.google.com/forms/d/e/ABC/viewform');
await p.waitForFunction(() => [...document.querySelectorAll('.af-chip')].filter((c) => c.dataset.tone === 'ready').length >= 2, null, { timeout: 170000 })
  .catch(() => console.log('not both ready in time'));
console.log('seconds until the suggestions were ready:', Math.round((Date.now() - t0) / 1000));
console.log('chips:', await p.$$eval('.af-chip', (n) => n.map((x) => x.textContent)));
console.log('before any click, textarea:', JSON.stringify(await p.$eval('#m', (e) => e.value)), '| input:', JSON.stringify(await p.$eval('#b6', (e) => e.value)));

for (const id of ['#m', '#b6']) {
  const idx = await p.evaluate((sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return [...document.querySelectorAll('.af-chip')].findIndex((c) => {
      const cr = c.getBoundingClientRect();
      return Math.abs(cr.top + cr.height / 2 - (r.top + r.height / 2)) < r.height;
    });
  }, id);
  if (idx < 0) { console.log(id, 'no chip beside it'); continue; }
  const chip = (await p.$$('.af-chip'))[idx];
  console.log(id, 'pill:', (await chip.textContent()).slice(0, 70));
  await (await chip.$('.af-chip-main')).click();
  await p.waitForTimeout(800);
  console.log(id, 'value after clicking the pill:', JSON.stringify((await p.$eval(id, (e) => e.value)).slice(0, 60)));
  const left = await p.$$eval('.af-chip', (n, sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return n.filter((c) => c.style.display !== 'none' && Math.abs(c.getBoundingClientRect().top + 8 - (r.top + r.height / 2)) < r.height).length;
  }, id);
  console.log(id, left === 0 ? 'PASS pill is gone after accepting' : `FAIL ${left} pill(s) still beside the box`);
}
await ctx.close();
