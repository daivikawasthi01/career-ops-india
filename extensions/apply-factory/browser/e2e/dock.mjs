import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2];
const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'af-profile-')), { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
const html = `<!doctype html><title>Backend Engineer</title><main><h1>Backend Engineer</h1><p>${'Build services in Go and AWS. '.repeat(40)}</p><form>
<label for=a>First Name</label><input id=a><label for=b>Last Name</label><input id=b><label for=c>Email Address</label><input id=c type=email>
<label for=d>Job title</label><input id=d><label for=e>Company name</label><input id=e></form></main>`;
await ctx.route('https://careers.dockdemo.net/**', (r) => r.fulfill({ contentType: 'text/html', body: html }));
const p = await ctx.newPage();
await p.setViewportSize({ width: 1300, height: 800 });
await p.goto('https://careers.dockdemo.net/apply');
const ok = await p.waitForSelector('.af-dock iframe', { timeout: 30000 }).then(() => true).catch(() => false);
console.log('dock opened by itself:', ok);
await p.waitForTimeout(6000);
await p.screenshot({ path: `${out}/dock.png` });
if (ok) { await p.click('.af-dock-x'); await p.waitForSelector('.af-pill', { timeout: 5000 }).then(() => console.log('pill after close: yes')).catch(() => console.log('pill after close: no')); }
await ctx.close();
