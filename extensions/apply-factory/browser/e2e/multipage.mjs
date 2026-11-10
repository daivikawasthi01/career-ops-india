// A two-step form whose "next" control is not worded like Next or Submit: step 1 answers must still be learned when the page changes.
import { chromium } from 'playwright';
import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, '..');
const html = readFileSync(path.join(here, 'multipage.html'), 'utf8');
const URL9 = 'https://boards.greenhouse.io/acme/jobs/9';
const q = (sql) => execFileSync('sqlite3', [process.env.AF_E2E_DB, sql]).toString().trim();
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'af-profile-')), {
  channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const page = await ctx.newPage();
await page.route(URL9, (r) => r.fulfill({ contentType: 'text/html', body: html }));
await page.goto(URL9);
await page.waitForTimeout(3000);
check('step 1 fields are filled from the profile', (await page.$eval('#fn', (e) => e.value)) === 'Daivik');
await page.fill('#db', 'Postgres');
await page.waitForTimeout(800);
await page.click('#go');
await page.waitForSelector('#step2:not([hidden])');
check('the page moved on without a Next or Submit button', true);
let found = false;
for (let i = 0; i < 60 && !found; i++) { await page.waitForTimeout(1500); found = /postgres/i.test(q('select answer from kb_entries')); }
check('step 1 answer was learned when the page changed', found, q("select intent_key || '=' || answer from kb_entries where answer like '%ostgres%'"));
await page.waitForTimeout(3000);
check('step 2 loaded and its fields were found', (await page.$eval('#ln', (e) => e.value)) === 'Awasthi');
await ctx.close();
console.log(results.every(Boolean) ? '\nALL PASS' : '\nSOME FAILED');
process.exit(results.every(Boolean) ? 0 : 1);
