// Stress test: one form with many long open questions and a few short ones. Prints when each suggestion pill appears, so the
// time to the first pill, to half and to all of them is measured on the real server and model, and checks each answer's length.
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIMIT_S = Number(process.env.STRESS_LIMIT_S || 420);
const LONG = [
  'What is your best achievement till date?', 'Why do you want to work here?', 'Message for the hiring team',
  'Describe your experience with AWS', 'Tell us about a challenge you overcame', 'Describe a project you are proud of',
  'What are your greatest strengths?', 'Why are you interested in this role?', 'Tell us about yourself',
  'Describe your experience with backend systems', 'Walk us through a technical decision you made', 'Describe a time you worked in a team',
  'What did you learn from your internship?', 'Describe your experience with Kubernetes', 'Tell us about a time you failed',
  'What motivates you at work?', 'Describe your experience with databases', 'What would you build in your first 90 days?',
  'Describe a conflict you resolved', 'Anything else you would like us to know?',
];
const SHORT = ['Current city', 'What is your favourite programming language?', 'LinkedIn profile URL', 'How did you hear about us?'];
const items = [...SHORT.slice(0, 2).map((q) => ['text', q]), ...LONG.map((q) => ['textarea', q]), ...SHORT.slice(2).map((q) => ['text', q])];
const html = `<!doctype html><title>Stress form</title><main style="max-width:640px;margin:20px auto"><form>${items.map(([t, q], i) =>
  `<div role=listitem style="margin:18px 0"><div id=q${i}>${q}</div>${t === 'textarea' ? `<textarea id=f${i} rows=4 style="width:100%" aria-labelledby=q${i}></textarea>` : `<input id=f${i} type=text style="width:100%" aria-labelledby=q${i}>`}</div>`).join('')}</form></main>`;

const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'af-profile-')), {
  channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
await ctx.route('https://docs.google.com/forms/**', (r) => r.fulfill({ contentType: 'text/html', body: html }));
const p = await ctx.newPage();
await p.setViewportSize({ width: 1300, height: 900 });
const t0 = Date.now();
const seen = new Map();   // question index -> seconds when its pill turned ready
const shown = new Map();  // question index -> seconds when it first showed any pill
const pillText = new Map();
await p.goto('https://docs.google.com/forms/d/e/STRESS/viewform');
for (;;) {
  const rows = await p.evaluate((n) => {
    const chips = [...document.querySelectorAll('.af-chip')].map((c) => ({ r: c.getBoundingClientRect(), tone: c.dataset.tone, text: c.textContent }));
    return Array.from({ length: n }, (_, i) => {
      const f = document.getElementById('f' + i).getBoundingClientRect();
      const c = chips.find((x) => x.r.top < f.bottom + 8 && x.r.bottom > f.top - 8 && x.r.width > 0);
      return c ? { tone: c.tone, text: c.text } : null;
    });
  }, items.length);
  const s = (Date.now() - t0) / 1000;
  if (process.env.STRESS_TRACE && rows[4] && rows[4].text !== globalThis.__last) { globalThis.__last = rows[4].text; console.log(`trace ${s.toFixed(1)}s: ${rows[4].text.slice(0, 60)}`); }
  rows.forEach((r, i) => {
    if (r && !shown.has(i)) shown.set(i, s);
    if (r && r.tone === 'ready' && !seen.has(i)) { seen.set(i, s); pillText.set(i, r.text); }
  });
  if (seen.size >= items.length || s > LIMIT_S) break;
  await p.waitForTimeout(500);
}
const total = (Date.now() - t0) / 1000;
const times = [...seen.values()].sort((a, b) => a - b);
const at = (k) => (times[Math.min(times.length - 1, Math.ceil(times.length * k) - 1)] ?? NaN).toFixed(0);
console.log(`questions: ${items.length} (${LONG.length} long)   pills ready: ${seen.size}   elapsed: ${total.toFixed(0)}s`);
console.log(`first pill: ${times[0]?.toFixed(0)}s   half: ${at(0.5)}s   90%: ${at(0.9)}s   last: ${times.at(-1)?.toFixed(0)}s`);
console.log(`every question showed a status pill within: ${Math.max(...[...shown.values()]).toFixed(0)}s (${shown.size}/${items.length})`);
for (const [i, q] of items.entries()) console.log(`${seen.has(i) ? seen.get(i).toFixed(0).padStart(4) + 's' : '  --- '} ${q[1].slice(0, 46).padEnd(46)} ${pillText.has(i) ? pillText.get(i).slice(0, 70) : (shown.has(i) ? '[still ' + 'waiting]' : '')}`);
const vals = await p.evaluate((n) => Array.from({ length: n }, (_, i) => document.getElementById('f' + i).value), items.length);
const filled = vals.map((v, i) => (v && !seen.has(i) ? i : -1)).filter((i) => i >= 0);
console.log(`filled from saved answers (no pill needed): ${filled.length}`, filled.map((i) => items[i][1].slice(0, 30)).join(' | '));
const stuck = items.map((q, i) => i).filter((i) => !seen.has(i) && !vals[i]);
console.log(`neither pill nor value: ${stuck.length}`, stuck.map((i) => items[i][1].slice(0, 30)).join(' | '));
await ctx.close();
