// Each pill must answer its own question: open questions get prose, a choose-one question gets one of its options.
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
<div role=listitem><div id=q2>What is your best achievement till date?</div><input id=b2 type=text aria-labelledby=q2></div>
<div role=listitem><div id=q3>What are you currently doing?</div><div role=radiogroup aria-labelledby=q3 id=g3>
  <div role=radio aria-checked=false aria-label="Working full-time" tabindex=0>Working full-time</div>
  <div role=radio aria-checked=false aria-label="Studying" tabindex=0>Studying</div>
  <div role=radio aria-checked=false aria-label="Freelancing" tabindex=0>Freelancing</div></div></div>
<div role=listitem><div id=q4>Why do you want to work here?</div><textarea id=m4 aria-labelledby=q4></textarea></div>
<div role=listitem><div id=q5>Which cloud platform have you used most?</div><select id=s5 aria-labelledby=q5><option>Choose</option><option>AWS</option><option>Azure</option><option>Google Cloud</option></select></div>
</form></main>`;
await ctx.route('https://docs.google.com/forms/**', (r) => r.fulfill({ contentType: 'text/html', body: html }));
const p = await ctx.newPage();
await p.setViewportSize({ width: 1300, height: 1000 });
const t0 = Date.now();
await p.goto('https://docs.google.com/forms/d/e/ABC/viewform');
await p.waitForFunction(() => document.querySelectorAll('.af-chip[data-tone="ready"]').length >= 4, null, { timeout: 200000 })
  .catch(() => console.log('not all four ready in time'));
console.log('seconds:', Math.round((Date.now() - t0) / 1000));
const rows = await p.evaluate(() => {
  const pairs = [['q2', '#b2'], ['q3', '#g3'], ['q4', '#m4'], ['q5', '#s5']];
  return pairs.map(([q, sel]) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    const chip = [...document.querySelectorAll('.af-chip')].find((c) => {
      const cr = c.getBoundingClientRect();
      return cr.top < r.bottom + 6 && cr.bottom > r.top - 6;
    });
    return { question: document.getElementById(q).textContent, pill: chip ? chip.textContent : '(none)' };
  });
});
for (const r of rows) console.log(`Q: ${r.question}\n   pill: ${r.pill}`);
await ctx.close();
