// The markup of mastertech.co.in's application form: questions as plain paragraphs, three questions in a table header over their boxes, an Email
// question ending in "(Read our privacy policy)", and a page script that resets the form after it loaded. Each box must get its own question,
// the Email box must be recognised, and what was filled must be filled again after the page wipes it.
// Needs a server running from e2e/server.py. Run: node browser/e2e/labels.mjs
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL = 'https://boards.greenhouse.io/acme/jobs/2';
const html = `<!doctype html><title>Apply</title><h1>Apply For This Position</h1><form>
<p>Your Name*</p><p><span><input id="nm" name="your-name" type="text"></span></p>
<p>Your Email* <small>(Read our <a href="/privacy">privacy policy</a>)</small></p><p><span><input id="em" name="your-email" type="email"></span></p>
<table><tr><td><p>Current CTC (LPA)*</p></td><td><p>Expected CTC (LPA)*</p></td><td><p>LinkedIn URL</p></td></tr>
<tr><td><p><input id="cc" name="curr-ctc" type="number"></p></td><td><p><input id="ec" name="exp-ctc" type="number"></p></td><td><p><input id="li" name="LinkedInURL" type="url"></p></td></tr></table>
<p>Submit a latest copy for your resume*</p><p><input id="cv" type="file" name="resume"></p></form>
<script>setTimeout(() => document.querySelector('form').reset(), 3500)</script>`;   // the page clears its own form shortly after load, as the Contact Form 7 page does
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'af-profile-')), { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
const page = await ctx.newPage();
await page.route(URL, (r) => r.fulfill({ contentType: 'text/html', body: html }));
await page.goto(URL);
await page.waitForTimeout(8000);   // past the page's own reset
const val = (sel) => page.$eval(sel, (e) => e.value);
check('name still filled after the page cleared its form', (await val('#nm')) === 'Daivik Awasthi', await val('#nm'));
check('email filled although its label ends in a privacy-policy note', (await val('#em')) === 'daivikawasthi.01@gmail.com', await val('#em'));
check('linkedin box gets the LinkedIn URL', /linkedin\.com\/in\//.test(await val('#li')), await val('#li'));
check('current CTC is not filled with the LinkedIn URL', !/linkedin/.test(await val('#cc')), await val('#cc'));
check('expected CTC is not filled with the LinkedIn URL', !/linkedin/.test(await val('#ec')), await val('#ec'));
// Another theme's markup: one <label> holding three questions and their boxes.
const URL2 = 'https://boards.greenhouse.io/acme/jobs/4';
await page.route(URL2, (r) => r.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Apply</title><form><label>Your Name* <input id="n"> Current CTC (LPA)* <input id="c"> LinkedIn URL <input id="l"></label>
<p><label>Your Email <input id="e" type="email"></label></p><p>Phone <input name="phone"></p></form>` }));
await page.goto(URL2);
await page.waitForTimeout(4000);
check('a label holding several boxes: each gets its own answer', (await val('#n')) === 'Daivik Awasthi' && /linkedin\.com/.test(await val('#l')) && !/linkedin/.test(await val('#c')), `${await val('#n')} | ${await val('#c')} | ${await val('#l')}`);
await ctx.close();
process.exit(results.every(Boolean) ? 0 : 1);
