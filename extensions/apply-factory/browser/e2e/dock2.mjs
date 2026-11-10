import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'af-profile-')), { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
const form = `<!doctype html><title>Form</title><main><h1>Application</h1><form>
<div role=listitem><div id=q1>What's your full name?</div><input id=a aria-labelledby=q1></div>
<div role=listitem><div id=q2>What's your email?</div><input id=c type=email aria-labelledby=q2></div>
<div role=listitem><div id=q3>What's your phone number?</div><input id=d aria-labelledby=q3></div>
<div role=listitem><div id=q4>What is your current status?</div><div role=radiogroup aria-labelledby=q4>
 <div role=radio aria-checked=false aria-label="Working full-time" tabindex=0>Working full-time</div>
 <div role=radio aria-checked=false aria-label="Studying" tabindex=0>Studying</div></div></div></form></main>`;
// Google-like headers: a strict CSP that limits frames and Trusted Types
const csp = "default-src 'self'; frame-src 'self' https://*.google.com; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; require-trusted-types-for 'script'";
await ctx.route('https://docs.google.com/forms/**', (r) => r.fulfill({ contentType: 'text/html', headers: { 'content-security-policy': csp }, body: form }));
const p = await ctx.newPage();
p.on('console', (m) => { if (/af|Refused|Trusted|CSP|Content Security/i.test(m.text())) console.log('console:', m.text().slice(0, 220)); });
await p.goto('https://docs.google.com/forms/d/e/ABC/viewform');
await p.waitForFunction(() => document.querySelector('#a')?.value && document.querySelector('#d')?.value, null, { timeout: 30000 }).catch(() => {});
console.log('name:', await p.$eval('#a', (e) => e.value), '| email:', await p.$eval('#c', (e) => e.value), '| phone:', await p.$eval('#d', (e) => e.value));
await p.waitForTimeout(5000);
console.log('dock element:', !!(await p.$('.af-dock')), 'pill:', !!(await p.$('.af-pill')));
const frames = p.frames().map((f) => f.url().slice(0, 80));
console.log('frames:', frames);
await ctx.close();
