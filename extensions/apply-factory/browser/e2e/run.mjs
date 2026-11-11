// End-to-end check: loads the unpacked extension in Chromium, serves a fake application page at a Greenhouse URL
// (so the content script injects), and verifies fill, capture and the side panel state.
// Needs: a server running from e2e/server.py. Run: node browser/e2e/run.mjs
import { chromium } from 'playwright';
import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, '..');
const html = readFileSync(path.join(here, 'fixture.html'), 'utf8');
const URL = 'https://boards.greenhouse.io/acme/jobs/1';
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'af-profile-')), {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('page error:', m.text().slice(0, 200)); });
await page.route(URL, (r) => r.fulfill({ contentType: 'text/html', body: html }));
await page.goto(URL);
await page.waitForTimeout(3500);

const val = (sel) => page.$eval(sel, (e) => e.value);
check('first name filled', (await val('#fn')) === 'Daivik', await val('#fn'));
check('last name filled', (await val('#ln')) === 'Awasthi');
check('email filled', (await val('#em')) === 'daivikawasthi.01@gmail.com');
check('phone uses 10 digits for maxlength 10', (await val('#ph')) === '9311067931', await val('#ph'));
check('nationality dropdown picks Indian', (await val('#nat')) === 'Indian');
check('college dropdown picks NSIT via alias', (await val('#clg')) === 'NSIT', await val('#clg'));
check('work authorization radio picks Yes', await page.$eval('input[name=auth][value=y]', (e) => e.checked));
check('gender left alone', (await val('#gen')) === '');
check('expected CTC left alone', (await val('#ctc')) === '');
check('free-text question left alone before drafting', (await val('#why')) === '');
check('default CV attached for a backend role', (await page.$eval('#cv', (e) => e.files[0]?.name)) === 'Daivik-Awasthi-Resume.pdf');
check('paste-your-resume box gets plain text from cv.md', (await val('#pr')).includes('Daivik'));
check('consent checkbox untouched', !(await page.$eval('input[name=terms]', (e) => e.checked)));

// the side panel reads state through the background worker
const worker = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 5000 }).catch(() => null));
const extId = worker ? new globalThis.URL(worker.url()).host : null;
check('service worker running', !!extId);
const tabId = await worker.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, URL);
const panel = await ctx.newPage();
await panel.setViewportSize({ width: 400, height: 900 });
await panel.goto(`chrome-extension://${extId}/app/panel.html?tab=${tabId}`);
await panel.waitForTimeout(1500);
const shot = process.env.AF_SHOTS || tmpdir();
await panel.screenshot({ path: path.join(shot, 'panel-1-filled.png'), fullPage: true });
const text = await panel.locator('#app').innerText();
check('panel shows the fill count', /\d+\s*of\s*\d+ saved answers filled/.test(text.replace(/\n+/g, ' ')), text.split('\n').slice(0, 6).join(' / '));
check('panel lists the free-text question under Needs you', /Needs you/i.test(text) && /Why do you want to work at Acme/.test(text));
check('panel does not list the consent checkbox as fillable', !/Ready[\s\S]*terms and conditions/.test(text));

// draft one answer from the panel with the local model, then use it
await panel.locator('[data-field]', { hasText: 'Why do you want to work at Acme' }).getByRole('button', { name: 'Draft', exact: true }).click();
await panel.waitForSelector('[data-field] textarea', { timeout: 90000 });
const drafted = await panel.locator('[data-field] textarea').first().inputValue();
check('draft written by the local model', drafted.length > 40, JSON.stringify(drafted.slice(0, 120)));
await panel.screenshot({ path: path.join(shot, 'panel-2-draft.png'), fullPage: true });
await panel.getByRole('button', { name: 'Insert answer' }).click();
await page.waitForTimeout(800);
check('draft inserted into the page after Use', (await val('#why')).length > 40);

// job card: checks and a quick score from the local model
await panel.getByRole('button', { name: 'Check this job' }).click();
await panel.waitForSelector('.checks li', { timeout: 90000 });
const checkText = await panel.locator('.checks').innerText();
check('job checks list five rows', (await panel.locator('.checks li').count()) === 5, checkText.replace(/\n+/g, ' / ').slice(0, 200));
check('employer site is recognised (not an aggregator)', /employer's own site/.test(checkText));
await panel.getByRole('button', { name: 'Score it' }).click();
await panel.waitForSelector('.score .figure', { timeout: 180000 });
const scoreText = await panel.locator('.score').innerText();
const globalScore = parseFloat(await panel.locator('.score .figure').first().innerText());
check('quick score is on the 1 to 5 scale with five dimensions', globalScore >= 1 && globalScore <= 5 && (await panel.locator('.score .dim').count()) === 5, `${globalScore}`);
await panel.screenshot({ path: path.join(shot, 'panel-4-job.png'), fullPage: true });

// cover letter: draft, attach as pdf (tectonic)
await panel.locator('[data-field]', { hasText: 'Cover letter' }).getByRole('button', { name: 'Draft cover letter' }).click();
await panel.waitForSelector('[data-field] textarea[aria-label="Cover letter"]', { timeout: 180000 });
check('cover letter drafted', (await panel.locator('[data-field] textarea[aria-label="Cover letter"]').inputValue()).length > 100);
await panel.getByRole('button', { name: 'Attach as PDF' }).click();
await page.waitForFunction(() => document.querySelector('#cl').files.length === 1, null, { timeout: 60000 });
check('cover letter pdf attached to the form', (await page.$eval('#cl', (e) => e.files[0].name)).startsWith('Cover-Letter-'), await page.$eval('#cl', (e) => e.files[0].name));

// replacing the default CV from the panel
if (process.env.AF_E2E_DB) {
  await panel.locator('input[type=file]').first().setInputFiles({ name: 'new.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 replaced') });
  await panel.waitForTimeout(1500);
  const saved = readFileSync(path.join(path.dirname(process.env.AF_E2E_DB), 'Daivik-Awasthi-Resume.pdf'), 'utf8');
  check('CV replaced from the panel becomes the default file', saved === '%PDF-1.4 replaced', saved.slice(0, 30));
  check('panel confirms the upload', /Saved Daivik-Awasthi-Resume\.pdf/.test(await panel.locator('#app').innerText()));
}

// an empty required field is outlined when the user clicks submit
await page.fill('#fn', '');
await page.click('button[type=submit]');
await page.waitForTimeout(600);
check('empty required field is outlined on the page', (await page.$eval('#fn', (e) => e.getAttribute('data-af'))) === 'missing');
await panel.reload();
await panel.waitForTimeout(1200);
check('panel lists the empty required field', /1 required field empty/.test(await panel.locator('#app').innerText()));
await page.fill('#fn', 'Daivik');

// the user types the rest by hand, then submits: capture should learn it
await page.fill('#fav', 'Python');
await page.fill('#ctc', '6 LPA');
await page.fill('#why', 'I like that the team ships small, tested changes every week and owns them from design to production. That matches how I worked at my internship.');
await page.click('button[type=submit]');
await page.waitForTimeout(500);
check('page submit handler still ran (never blocked)', await page.evaluate(() => window.submitted === true));

// capture is learned in the background; the model normalises the two new questions
const db = process.env.AF_E2E_DB;
if (db) {
  const q = (sql) => execFileSync('sqlite3', [db, sql]).toString().trim();
  let n = 0;
  for (let i = 0; i < 60 && n < 1; i++) { await page.waitForTimeout(1500); n = Number(q("select count(*) from kb_entries where answer like '%Python%'")); }
  const entries = q('select intent_key || "=" || answer from kb_entries');
  console.log('--- learned ---\n' + entries);
  check('email learned', /email=daivikawasthi/.test(entries));
  check('new question learned from what was typed', /favourite.*=Python/.test(entries));
  check('long answer is not stored as a reusable answer', !/ships small/.test(entries));
  check('expected CTC learned (sensitive fields are stored, never drafted)', /6 LPA/.test(entries));
  check('long answer kept as a writing sample', Number(q('select count(*) from writing_samples')) >= 1);
  check('consent checkbox not learned', !/terms/i.test(entries));
}
await panel.reload();
await panel.waitForTimeout(1200);
await panel.screenshot({ path: path.join(shot, 'panel-3-after.png'), fullPage: true });

// a DevOps role gets the DevOps CV
const devops = await ctx.newPage();
const URL2 = 'https://jobs.lever.co/acme/2';
await devops.route(URL2, (r) => r.fulfill({ contentType: 'text/html', body: html.replaceAll('Backend Engineer', 'DevOps Engineer') }));
await devops.goto(URL2);
await devops.waitForTimeout(3500);
check('DevOps CV attached for a DevOps role', (await devops.$eval('#cv', (e) => e.files[0]?.name)) === 'Daivik-Awasthi-DevopsResume.pdf');

await ctx.close();
console.log(results.every(Boolean) ? '\nALL PASS' : '\nSOME FAILED');
process.exit(results.every(Boolean) ? 0 : 1);
