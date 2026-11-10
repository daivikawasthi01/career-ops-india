// The in-page panel must not open while Chrome's own side panel is open in the same window.
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'af-profile-')), { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
const html = `<!doctype html><title>Form</title><main><form><label for=a>First Name</label><input id=a><label for=b>Last Name</label><input id=b><label for=c>Email Address</label><input id=c type=email><label for=d>Job title</label><input id=d></form></main>`;
await ctx.route('https://careers.dockdemo.net/**', (r) => r.fulfill({ contentType: 'text/html', body: html }));
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
const id = new URL(sw.url()).host;
const results = [];
const check = (n, ok) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`); };

const a = await ctx.newPage();
await a.goto('https://careers.dockdemo.net/apply');
await a.waitForSelector('.af-dock iframe', { timeout: 30000 }).catch(() => {});
check('with no side panel open the page panel opens by itself', !!(await a.$('.af-dock')));

const panel = await ctx.newPage(); // stands in for the side panel: same page, top-level, same window
await panel.goto(`chrome-extension://${id}/panel/index.html`);
await panel.waitForTimeout(1500);
const b = await ctx.newPage();
await b.goto('https://careers.dockdemo.net/apply?second=1');
await b.waitForFunction(() => document.querySelector('#a')?.value, null, { timeout: 30000 }).catch(() => {});
await b.waitForTimeout(4000);
check('with the side panel open the page panel stays away', !(await b.$('.af-dock')) && !(await b.$('.af-pill')));
await panel.close();
await ctx.close();
process.exit(results.every(Boolean) ? 0 : 1);
