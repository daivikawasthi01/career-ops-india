// Screenshots of the side panel (dark and light) beside a form with suggestions, and of the CV studio. Written to AF_SHOTS or /tmp.
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.env.AF_SHOTS || tmpdir();
const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'af-profile-')), {
  channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const html = `<!doctype html><title>Careers</title><main style="max-width:640px;margin:20px auto"><form>
<div role=listitem><div id=q0>First Name</div><input id=f0 aria-labelledby=q0></div>
<div role=listitem><div id=q1>Email Address</div><input id=f1 type=email aria-labelledby=q1></div>
<div role=listitem><div id=q2>What is your best achievement till date?</div><textarea id=f2 rows=4 aria-labelledby=q2></textarea></div>
<div role=listitem><div id=q3>Why do you want to work here?</div><textarea id=f3 rows=4 aria-labelledby=q3></textarea></div>
<div role=listitem><div id=q4>Message for the hiring team</div><textarea id=f4 rows=4 aria-labelledby=q4></textarea></div>
</form></main>`;
await ctx.route('https://docs.google.com/forms/**', (r) => r.fulfill({ contentType: 'text/html', body: html }));
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
const id = new URL(sw.url()).host;
const page = await ctx.newPage();
await page.setViewportSize({ width: 1100, height: 800 });
await page.goto('https://docs.google.com/forms/d/e/SHOT/viewform');
await page.waitForFunction(() => document.querySelectorAll('.af-chip[data-tone="ready"]').length >= 2, null, { timeout: 120000 }).catch(() => {});
await page.screenshot({ path: path.join(out, 'page-with-pills.png') });
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://docs.google.com/forms/*' }))[0].id);
const panel = await ctx.newPage();
await panel.setViewportSize({ width: 400, height: 1100 });
await panel.goto(`chrome-extension://${id}/app/panel.html?tab=${tabId}`);
await panel.waitForTimeout(2500);
await panel.screenshot({ path: path.join(out, 'panel-dark.png'), fullPage: true });
await panel.getByRole('button', { name: 'Toggle theme' }).click();
await panel.waitForTimeout(400);
await panel.screenshot({ path: path.join(out, 'panel-light.png'), fullPage: true });
const studio = await ctx.newPage();
await studio.setViewportSize({ width: 1300, height: 900 });
await studio.goto(`chrome-extension://${id}/app/studio.html#view=edit`);
await studio.waitForTimeout(2500);
await studio.screenshot({ path: path.join(out, 'studio-dark.png') });
const errors = [];
for (const pg of [panel, studio]) pg.on('pageerror', (e) => errors.push(String(e)));
console.log('shots in', out, errors.length ? errors : 'no page errors');
await ctx.close();
