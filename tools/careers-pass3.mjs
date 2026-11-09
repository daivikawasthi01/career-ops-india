#!/usr/bin/env node
/**
 * careers-pass3.mjs: for companies whose portal is right but shows no India postings (pass 2 status right-portal-no-india),
 * look for the India version of the same portal, e.g. apple.com/careers/us/ -> apple.com/careers/in/.
 *   1. India versions of the URL by pattern (/us/ -> /in/, /en-us/ -> /en-in/, country=US -> IN, an in. subdomain, /in/ prefix);
 *   2. then searches "<name> careers sde india", keeping only results on the same site or the same ATS tenant.
 * Each candidate gets the same jobs test as pass 2. A candidate replaces the portal only if it has India postings and the old one
 * had none. Output data/careers-pass3.tsv (a suggestion: nothing else is changed; you accept it in the dashboard).
 *
 *   node tools/careers-pass3.mjs [--limit N] [--only NAME,NAME] [--workers 2]
 */
import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isMainModule } from '../lib/is-main-module.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { atsFromUrl } from '../lib/careers-discovery.mjs';
import { redact, queryPair } from '../lib/careers-pipeline.mjs';
import { indiaVariants, indiaFilterLinks, keyOf, sameOwner, pass3Decision, mark, seen, rankCandidates, PASSING, LIMITS } from '../lib/careers-pass2.mjs';
import { testUrl, initEnv, readDone2 } from './careers-pass2.mjs';
import { searchResults, hostOf, Halt, sleep, setSessionContext, visit } from './discover-careers.mjs';

const ROOT = getCareerOpsRoot();
const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const IN = process.env.CAREER_OPS_PASS2 || join(ROOT, 'data', 'careers-pass2.tsv');
const OUT = arg('--out') || join(ROOT, 'data', 'careers-pass3.tsv');
const COLS = ['company', 'decision', 'old_url', 'new_url', 'ats', 'old_india', 'new_india', 'new_total', 'tests', 'tried', 'notes'];
const line = (r) => COLS.map((c) => redact(String(r[c] ?? '')).replace(/[\t\r\n]+/g, ' ').trim()).join('\t');
const parse = (text) => { const [h, ...ls] = text.split('\n').filter(Boolean); const cols = h.split('\t'); return ls.map((l) => { const c = l.split('\t'); return Object.fromEntries(cols.map((k, i) => [k, c[i] ?? ''])); }); };

async function processCompany3({ context, row }) {
  const name = row.company; const old = row.careers_url;
  const st = { tried: new Map(), tests: 0, results: [], queries: [], models: new Set(), notes: [] };
  mark(st.tried, old, 'current');
  st.trusted = new Set([keyOf(old, atsFromUrl)]); // pass 2 already settled that this portal is the company's
  const cands = []; // verdict records for tested candidates that belong to the same owner
  const test = async (url) => { if (seen(st.tried, url) || st.tests >= LIMITS.maxTests || !sameOwner(old, url, atsFromUrl)) return; const r = await testUrl(context, url, name, st); if (PASSING.has(r.verdict) || r.verdict === 'board-empty') cands.push(r); };
  for (const v of indiaVariants(old)) await test(v);
  if (!cands.some((c) => (c.india || 0) > 0)) { // a location filter link on the page itself (Apple, Google style global portals)
    const page = await visit(context, old);
    if (page.ok) for (const l of indiaFilterLinks(page.links, hostOf(page.finalUrl))) await test(l.href);
  }
  if (!cands.some((c) => (c.india || 0) > 0)) {
    for (const q of queryPair(name, {}, 0).slice(0, 2)) {
      const res = await searchResults(context, q);
      st.queries.push(q);
      for (const c of rankCandidates(res.filter((r) => sameOwner(old, r.url, atsFromUrl)), st.tried, { limit: LIMITS.perRound, companyHost: hostOf(old) })) await test(c.url);
    }
  }
  const bestC = [...cands].sort((a, b) => (b.india || b.indiaMentions || 0) - (a.india || a.indiaMentions || 0))[0] || null;
  const decision = pass3Decision({ oldIndia: row.jobs_india, candidate: bestC });
  return {
    company: name, decision, old_url: old, new_url: decision === 'switch' ? bestC.url : '', ats: bestC?.ats || row.ats, old_india: row.jobs_india,
    new_india: bestC?.india ?? '', new_total: bestC?.total ?? '', tests: st.tests, tried: JSON.stringify(st.results.slice(0, 10).map((r) => ({ u: r.url, v: r.verdict }))), notes: st.queries.join(' | '),
  };
}

async function main() {
  const rows = parse(read(IN)).filter((r) => r.final_status === 'right-portal-no-india' && r.careers_url);
  const done = readDone2(read(OUT));
  const only = new Set((arg('--only') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  let todo = rows.filter((r) => !done.has(r.company.toLowerCase()) && (!only.size || only.has(r.company.toLowerCase())));
  if (Number(arg('--limit'))) todo = todo.slice(0, Number(arg('--limit')));
  if (!todo.length) { console.log('Nothing to do.'); return 0; }
  mkdirSync(dirname(OUT), { recursive: true });
  if (!existsSync(OUT)) writeFileSync(OUT, COLS.join('\t') + '\n');
  const lock = `${OUT}.lock`;
  if (existsSync(lock)) { const pid = Number(read(lock).trim()); let alive = false; try { process.kill(pid, 0); alive = pid > 0; } catch { /* stale */ } if (alive) { console.error(`Another pass 3 run (pid ${pid}) is writing ${OUT}.`); return 1; } }
  writeFileSync(lock, String(process.pid));
  const unlock = () => { try { if (read(lock).trim() === String(process.pid)) unlinkSync(lock); } catch { /* gone */ } };
  process.on('exit', unlock); for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { unlock(); process.exit(130); });
  await initEnv();
  const { chromium } = await import('playwright');
  const profile = join(ROOT, 'data', 'cache', 'careers-profile-pass3'); mkdirSync(profile, { recursive: true });
  const context = await chromium.launchPersistentContext(profile, browserLaunchOptions({ headless: true, viewport: { width: 1280, height: 900 } }));
  setSessionContext(context);
  await context.route('**/*', (route) => (['image', 'font', 'media'].includes(route.request().resourceType()) ? route.abort() : route.continue()));
  let next = 0; let stop = null; let n = 0; const counts = {};
  const worker = async () => {
    while (!stop && next < todo.length) {
      const row = todo[next++]; let r;
      try { r = await Promise.race([processCompany3({ context, row }), sleep(240000).then(() => { throw new Error('company deadline'); })]); } catch (err) {
        if (err instanceof Halt) { stop = stop || err; return; }
        r = { company: row.company, decision: 'error', old_url: row.careers_url, notes: String(err?.message || err).slice(0, 100) };
      }
      appendFileSync(OUT, line(r) + '\n'); counts[r.decision] = (counts[r.decision] || 0) + 1; n++;
      console.log(`[${n}/${todo.length}] ${row.company} ${r.decision} ${r.new_url || ''}`.slice(0, 180));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(arg('--workers')) || 2) }, worker));
  await context.close().catch(() => {});
  console.log('Summary:', JSON.stringify(counts));
  if (stop) { console.error(`HALTED: ${stop.message}`); return stop.code; }
  return 0;
}
if (isMainModule(import.meta.url)) main().then((c) => process.exit(c)).catch((e) => { console.error(redact(e?.stack || e)); process.exit(1); });
