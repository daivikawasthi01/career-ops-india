// Sloppy form markup: one <label> that holds three questions and their boxes, and an Email label ending in "(Read our privacy policy)".
// Each box must get its own question (never the whole label's text), the Email box must be recognised, and known answers must be filled.
// Needs a server running from e2e/server.py. Run: node browser/e2e/labels.mjs
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL = 'https://boards.greenhouse.io/acme/jobs/2';
const html = `<!doctype html><title>Apply</title><h1>Apply For This Position</h1><form>
<p><label>Your Name*<br><span><input id="nm" name="your-name" type="text"></span></label></p>
<p><label>Your Email* (Read our <a href="/privacy">privacy policy</a>)<br><span><input id="em" name="your-email" type="email"></span></label></p>
<p><label>Current CTC (LPA)*<br><input id="cc" name="ctc-now" type="text">
Expected CTC (LPA)*<br><input id="ec" name="ctc-want" type="text">
LinkedIn URL<br><input id="li" name="linkedin" type="text"></label></p>
<p><label>Submit a latest copy for your resume<br><input id="cv" type="file"></label></p></form>`;
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'af-profile-')), { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
const page = await ctx.newPage();
await page.route(URL, (r) => r.fulfill({ contentType: 'text/html', body: html }));
await page.goto(URL);
await page.waitForTimeout(4000);
const val = (sel) => page.$eval(sel, (e) => e.value);
check('name filled', (await val('#nm')) === 'Daivik Awasthi', await val('#nm'));
check('email filled although its label ends in a privacy-policy note', (await val('#em')) === 'daivikawasthi.01@gmail.com', await val('#em'));
check('linkedin box gets the LinkedIn URL', /linkedin\.com\/in\//.test(await val('#li')), await val('#li'));
check('current CTC is not filled with the LinkedIn URL', !/linkedin/.test(await val('#cc')), await val('#cc'));
check('expected CTC is not filled with the LinkedIn URL', !/linkedin/.test(await val('#ec')), await val('#ec'));
await ctx.close();
process.exit(results.every(Boolean) ? 0 : 1);
