// A company careers site that is not on any list and draws its form after load (like Phenom): it must be picked up once the
// address turns into an application, while an ordinary search page and a never-touch host stay untouched.
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const FORM = `
  <div><label for="fn">First Name</label><input id="fn" type="text"></div>
  <div><label for="ln">Last Name</label><input id="ln" type="text"></div>
  <div><label for="em">Email Address</label><input id="em" type="email"></div>
  <div><label for="ph">Mobile Number</label><input id="ph" type="tel"></div>`;

const spa = `<!doctype html><title>Careers</title><main id="app"><h1>Open roles</h1><p>Browse jobs.</p></main>
<script>setTimeout(() => { history.pushState({}, '', '/us/en/apply?jobSeqNo=1&step=2&stepname=workAndEducation'); document.getElementById('app').innerHTML = '<h1>Apply</h1><form>${FORM.replace(/\n\s*/g, '')}</form>'; }, 2500);</script>`;
const byFields = `<!doctype html><title>Portal</title><main><h1>Step 2</h1><form>${FORM}
  <div><label for="jt">Job title</label><input id="jt" type="text"></div>
  <div><label for="cn">Company name</label><input id="cn" type="text"></div></form></main>`;
const plain = `<!doctype html><title>Search</title><main><h1>Search</h1><form>${FORM}</form></main>`;

const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'af-profile-')), {
  channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
await ctx.route('https://jobs.carehub-example.com/**', (r) => r.fulfill({ contentType: 'text/html', body: spa }));
await ctx.route('https://www.example.org/**', (r) => r.fulfill({ contentType: 'text/html', body: plain }));
await ctx.route('https://portal.example.net/**', (r) => r.fulfill({ contentType: 'text/html', body: byFields }));
await ctx.route('https://www.youtube.com/**', (r) => r.fulfill({ contentType: 'text/html', body: plain }));

const a = await ctx.newPage();
await a.goto('https://jobs.carehub-example.com/us/en/home');
await a.waitForFunction(() => document.querySelector('#fn')?.value === 'Daivik', null, { timeout: 45000 }).catch(() => {});
check('an unlisted careers site is picked up when its address becomes an application', (await a.$eval('#fn', (e) => e.value)) === 'Daivik', a.url());
await a.waitForFunction(() => document.querySelector('#em')?.value, null, { timeout: 30000 }).catch(() => {});
check('and the rest of the form is filled', (await a.$eval('#ln', (e) => e.value)) === 'Awasthi' && (await a.$eval('#em', (e) => e.value)).includes('@'));

const b = await ctx.newPage();
await b.goto('https://www.example.org/search?q=jobs-are-not-applications');
const c = await ctx.newPage();
await c.goto('https://www.youtube.com/apply');
await b.waitForTimeout(9000);
check('an ordinary page with the same fields is left alone', (await b.$eval('#fn', (e) => e.value)) === '' && (await b.$eval('#fn', (e) => e.getAttribute('data-af'))) === null);
check('a host on the never-touch list is left alone even with an application-like address', (await c.$eval('#fn', (e) => e.value)) === '');

const d = await ctx.newPage();
await d.goto('https://portal.example.net/session/7/page');
await d.waitForFunction(() => document.querySelector('#fn')?.value === 'Daivik', null, { timeout: 30000 }).catch(() => {});
check('a page with no application words in its address is detected from its fields', (await d.$eval('#fn', (e) => e.value)) === 'Daivik');

await ctx.close();
console.log(results.every(Boolean) ? '\nALL PASS' : '\nSOME FAILED');
process.exit(results.every(Boolean) ? 0 : 1);
