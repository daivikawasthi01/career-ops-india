// The red blacklist button on a job and the blacklist editor, against a throw-away jobs.db (browser/e2e/blacklist_server.py).
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.env.AF_SHOTS || tmpdir();
const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'af-profile-')), { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
const id = new URL(sw.url()).host;
const p = await ctx.newPage();
await p.setViewportSize({ width: 400, height: 900 });
const errors = [];
p.on('pageerror', (e) => errors.push(String(e)));
await p.goto(`chrome-extension://${id}/app/panel.html`);
await p.getByRole('tab', { name: 'Jobs' }).click();
await p.waitForSelector('[data-job]', { timeout: 20000 });
check('three jobs listed', (await p.locator('[data-job]').count()) === 3);

const red = p.locator('[data-blacklist-job]').first();
await red.click();
check('first press only asks', /Confirm/.test(await red.innerText()) && (await p.locator('[data-job]').count()) === 3);
await red.click();
await p.locator('[data-notice]').waitFor({ timeout: 15000 });
const notice = await p.locator('[data-notice]').innerText();
check('company blacklisted and its jobs removed', /Ghost Staffing Pvt Ltd is blacklisted, 2 jobs removed/.test(notice) && (await p.locator('[data-job]').count()) === 1, notice.replace(/\s+/g, ' '));
await p.screenshot({ path: path.join(out, 'blacklist-added.png') });

await p.getByRole('button', { name: 'Blacklist', exact: true }).click();
await p.locator('[data-blacklist]').waitFor();
await p.locator('[data-entry="Ghost Staffing Pvt Ltd"]').waitFor({ timeout: 10000 });
check('editor lists the company', (await p.locator('[data-entry="Ghost Staffing Pvt Ltd"]').count()) === 1);
await p.getByRole('button', { name: 'Edit Ghost Staffing Pvt Ltd' }).click();
await p.getByLabel('Reason').fill('posts the same job all day');
await p.getByLabel('Company', { exact: true }).fill('Ghost Staffing');
await p.getByRole('button', { name: 'Save' }).click();
await p.locator('[data-entry="Ghost Staffing"]').waitFor();
check('entry edited in place', /posts the same job all day/.test(await p.locator('[data-entry="Ghost Staffing"]').innerText()));
await p.screenshot({ path: path.join(out, 'blacklist-editor.png') });

await p.getByRole('button', { name: 'Remove Ghost Staffing from the blacklist' }).click();
await p.getByText('Nothing blacklisted yet').waitFor();
check('removing an entry empties the list', true);
check('no page errors', errors.length === 0, errors.join(' | '));
await ctx.close();
process.exit(results.every(Boolean) ? 0 : 1);
