// Diagnostic: load a form with the extension and print every page error and console message.
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'af-profile-')), {
  channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const html = `<!doctype html><title>Form</title><main><form><label for=a>First Name</label><input id=a><label for=b>Last Name</label><input id=b><label for=c>Email Address</label><input id=c type=email></form></main>`;
await ctx.route('https://docs.google.com/forms/**', (r) => r.fulfill({ contentType: 'text/html', body: html }));
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
sw.on?.('console', (m) => console.log('sw console:', m.text().slice(0, 200)));
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('PAGE ERROR:', String(e).slice(0, 300)));
p.on('console', (m) => { if (m.type() === 'error') console.log('console error:', m.text().slice(0, 300)); });
await p.goto('https://docs.google.com/forms/d/e/ABC/viewform');
await p.waitForTimeout(6000);
console.log('filled first name:', JSON.stringify(await p.$eval('#a', (e) => e.value)));
const r = await sw.evaluate(async () => {
  const res = await chrome.storage.local.get(null);
  return Object.keys(res);
});
console.log('extension storage keys:', r);
const hello = await sw.evaluate(async () => { try { const x = await fetch('http://127.0.0.1:8765/rules', { headers: { 'X-Token': (await chrome.storage.local.get('token')).token || '' } }); return x.status; } catch (e) { return String(e); } });
console.log('server /rules status from the extension:', hello);
await ctx.close();
