// Declarations (not a veteran, authorized to work, no disability) as checkboxes, bullets, styled list items and radio groups,
// plus searches that answer late and a list that needs "Other" with a text box. Needs a server started with AF_SEED_DECL=1.
import { chromium } from 'playwright';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, '..');
const html = readFileSync(path.join(here, 'declarations.html'), 'utf8');
const URL1 = 'https://boards.greenhouse.io/acme/jobs/7';
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'af-profile-')), {
  channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERR', e.message));
await page.route(URL1, (r) => r.fulfill({ contentType: 'text/html', body: html }));
await page.goto(URL1);
// fields are filled one after another, so wait for the last quick one (the radio group) before reading any of them
await page.waitForFunction(() => document.querySelector('#r2')?.checked, null, { timeout: 30000 }).catch(() => {});
check('"I am not a protected veteran" is ticked from an earlier answer', await page.$eval('#v1', (e) => e.checked));
check('the opposite statement is left alone', !(await page.$eval('#v2', (e) => e.checked)));
check('"legally authorized to work in India" is ticked from the profile', await page.$eval('#a1', (e) => e.checked));
check('a styled list item that behaves as a checkbox is ticked', (await page.$eval('#d1', (e) => e.getAttribute('aria-checked'))) === 'true');
check('and its opposite is not', (await page.$eval('#d2', (e) => e.getAttribute('aria-checked'))) === 'false');
check('a radio group with a different heading picks the statement you chose before', await page.$eval('#r2', (e) => e.checked));
check('the other radio options stay unchecked', !(await page.$eval('#r1', (e) => e.checked)) && !(await page.$eval('#r3', (e) => e.checked)));

// searches that answer late: the full name finds nothing, a short form does
await page.waitForFunction(() => /NSIT/.test(document.querySelector('#clg')?.value || ''), null, { timeout: 90000 }).catch(() => {});
check('a search that answers late finds the college through a shorter query', /NSIT/.test(await page.$eval('#clg', (e) => e.value)), await page.$eval('#clg', (e) => e.value));
await page.waitForFunction(() => document.querySelector('#od')?.value, null, { timeout: 90000 }).catch(() => {});
check('when nothing matches it chooses Other and types the answer', (await page.$eval('#deg', (e) => e.value)) === 'Other' && (await page.$eval('#od', (e) => e.value)) === 'B.Tech',
  `${await page.$eval('#deg', (e) => e.value)} / ${await page.$eval('#od', (e) => e.value)}`);

await ctx.close();
console.log(results.every(Boolean) ? '\nALL PASS' : '\nSOME FAILED');
process.exit(results.every(Boolean) ? 0 : 1);
