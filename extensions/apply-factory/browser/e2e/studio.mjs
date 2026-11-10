// CV studio end to end: import a real PDF with the local model, edit with live preview, publish, tailor, download.
// Needs e2e/server.py running (it copies output/resumes/Daivik-Awasthi-Resume.pdf as real-cv.pdf next to its database).
import { chromium } from 'playwright';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, '..');
const dbDir = path.dirname(process.env.AF_E2E_DB);
const realCv = path.join(dbDir, 'real-cv.pdf');
const shot = process.env.AF_SHOTS || tmpdir();
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
if (!existsSync(realCv)) { console.log('SKIP  no real CV pdf to import'); process.exit(0); }

const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'af-profile-')), {
  channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const worker = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
const id = new URL(worker.url()).host;
const studio = await ctx.newPage();
await studio.setViewportSize({ width: 1400, height: 900 });
studio.on('dialog', (d) => d.accept());
await studio.goto(`chrome-extension://${id}/studio/index.html#view=import`);
await studio.waitForTimeout(1500);

const seeded = !!process.env.AF_SEED_TEX;
if (!seeded) {
// 1. import
await studio.locator('input[type=file]').setInputFiles(realCv);
await studio.waitForSelector('text=Your original', { timeout: 900000 });
await studio.waitForTimeout(500);
await studio.screenshot({ path: path.join(shot, 'studio-1-import.png'), fullPage: true });
const importText = await studio.locator('#view').innerText();
check('import shows original and compiled pages', (await studio.locator('.pages img').count()) >= 2);
check('import lists unverified text or confirms all found', /not found in your PDF|Every piece of text was found/.test(importText), importText.match(/\d+ pieces? of text not found|Every piece[^\n]*/)?.[0] || '');

}
// 2. edit with live preview
if (seeded) { await studio.getByRole('tab', { name: 'Edit' }).click(); } else { await studio.getByRole('button', { name: 'Open in the editor' }).click(); }
await studio.waitForSelector('textarea.tex');
await studio.waitForSelector('#preview img', { timeout: 120000 });
const tex = await studio.locator('textarea.tex').inputValue();
check('editor holds the imported tex with tailoring markers', tex.includes('\\documentclass') && tex.includes('% AF:BEGIN skills'));
if (!seeded) check('banner asks for review of an imported CV', /Imported from a PDF/.test(await studio.locator('#view').innerText()));
const shotsOf = () => studio.$$eval('#preview img', (els) => els.map((e) => e.getAttribute('src').slice(-200)).join('|'));
const before = await shotsOf();
await studio.locator('textarea.tex').fill(tex.replace('\\begin{document}', '\\begin{document}\\textbf{LIVE EDIT CHECK}\\par'));
await studio.waitForFunction((b) => [...document.querySelectorAll('#preview img')].map((e) => e.getAttribute('src').slice(-200)).join('|') !== b, before, { timeout: 90000 });
check('preview updates by itself after an edit', true);
await studio.locator('textarea.tex').fill(tex.replace('\\end{document}', '\\boom\n\\end{document}'));
await studio.waitForSelector('.errors button', { timeout: 60000 });
check('a tex error is listed with its line', /Line \d+/.test(await studio.locator('.errors').first().innerText()), await studio.locator('.errors').first().innerText());
await studio.locator('textarea.tex').fill(tex);
await studio.waitForFunction(() => !document.querySelector('.errors button'), null, { timeout: 60000 });
await studio.screenshot({ path: path.join(shot, 'studio-2-edit.png'), fullPage: true });
await studio.getByRole('button', { name: /Publish as/ }).click();
await studio.waitForFunction(() => /Published/.test(document.getElementById('status').textContent), null, { timeout: 90000 });
check('publish writes the default CV pdf', readFileSync(path.join(dbDir, 'Daivik-Awasthi-Resume.pdf')).subarray(0, 5).toString() === '%PDF-');

// 3. tailor
await studio.getByRole('tab', { name: 'Tailor' }).click();
await studio.locator('input.field-input').first().fill('Acme');
await studio.locator('input.field-input').nth(1).fill('Cloud Engineer Intern');
await studio.locator('textarea.jd').fill('Cloud engineer intern. You will work with Kubernetes, Docker, Terraform and AWS to run services, write CI/CD pipelines in GitHub Actions, set up Prometheus and Grafana dashboards, and improve reliability with a small platform team. Strong Python or Go, Linux and networking fundamentals are expected. This is a paid internship in Bengaluru that can convert to a full time role.');
await studio.getByRole('button', { name: 'Tailor my CV' }).last().click();
await studio.waitForSelector('text=What changed', { timeout: 900000 });
await studio.screenshot({ path: path.join(shot, 'studio-3-tailor.png'), fullPage: true });
const tailorText = await studio.locator('#view').innerText();
check('tailor reports each region', /summary/.test(tailorText) && /skills/.test(tailorText));
const dl = studio.waitForEvent('download', { timeout: 90000 });
await studio.getByRole('button', { name: 'Download PDF' }).click();
const file = await dl;
check('tailored CV downloads as a pdf named for the company', /Acme\.pdf$/.test(file.suggestedFilename()), file.suggestedFilename());

await ctx.close();
console.log(results.every(Boolean) ? '\nALL PASS' : '\nSOME FAILED');
process.exit(results.every(Boolean) ? 0 : 1);
