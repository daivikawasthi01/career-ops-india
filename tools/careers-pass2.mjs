#!/usr/bin/env node
/**
 * careers-pass2.mjs: a second pass over data/careers-discovery.tsv. For each company, in file order:
 *   1. test the URL pass 1 found: an ATS board is fetched through the same providers scan.mjs uses (jobs > 0 passes);
 *      a custom page is loaded and classified (job links, "no open positions", a landing page to follow, bot block, not careers);
 *   2. if it does not pass, up to 3 repair rounds: the LLM proposes search queries from what was already tried, the results
 *      become new candidates, each is tested the same way. A URL is never tried twice, and the loop stops when a round finds
 *      nothing new, at 12 tests, or at 3 rounds, so every company ends;
 *   3. when a search shows nothing, a screenshot of it goes to a vision model that says what is happening (captcha, consent wall,
 *      results). URLs it reads off the screen are candidates only and must pass the same test.
 * Output data/careers-pass2.tsv (append-only, resumable). Never edits portals.yml, the pass 1 file or the review file.
 *
 *   node tools/careers-pass2.mjs --llm [--workers 3] [--limit N] [--only NAME,NAME] [--include-reviewed] [--no-vision]
 * Companies you ticked in the dashboard are skipped (they are settled) unless --include-reviewed. Crossed ones are retried and their
 * old URL is not offered again.
 */
import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createProgress } from '../lib/progress.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { loadYaml } from '../lib/yaml-document.mjs';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { atsFromUrl, findAtsLinks, pickAts, extractUrls } from '../lib/careers-discovery.mjs';
import { boardFingerprint, redact } from '../lib/careers-pipeline.mjs';
import { makeLlm, loadGroqKeys, loadModels } from '../lib/careers-llm.mjs';
import { slugMatchesName } from '../lib/board-audit.mjs';
import { classifyPage, followLinks, best, PASSING, CAREERS_PATH, identityOk, keyOf, rankCandidates, mark, seen, shouldStop, LIMITS, visionAction, INDIA_RE, indiaStatus, guessCareerUrls, HIRING_SIGNAL, visionListingsOk, indiaPass, outcomeOf, isIndiaLoc } from '../lib/careers-pass2.mjs';
import { parseTsv } from './careers-review.mjs';
import { visit, searchResults, hostOf, Halt, gov, sleep, setSessionContext } from './discover-careers.mjs';
import { queryPair } from '../lib/careers-pipeline.mjs';
import { nameInHost } from '../lib/careers-pass2.mjs';

const ROOT = getCareerOpsRoot();
const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const has = (n) => process.argv.includes(n);
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const IN = process.env.CAREER_OPS_DISCOVERY || join(ROOT, 'data', 'careers-discovery.tsv');
const OUT = arg('--out') || join(ROOT, 'data', 'careers-pass2.tsv');
const REVIEW = process.env.CAREER_OPS_REVIEW || join(ROOT, 'data', 'careers-review.json');
const PORTALS = process.env.CAREER_OPS_PORTALS || join(ROOT, 'portals.yml');
const ENV_DIRS = [process.env.CAREER_OPS_ENV_DIR, ROOT].filter(Boolean);
const REPO = join(dirname(new URL(import.meta.url).pathname), '..');
const COMPANY_DEADLINE_MS = Number(process.env.CAREER_OPS_COMPANY_DEADLINE_MS || 300000);
const COLS = ['company', 'final_status', 'outcome', 'careers_url', 'ats', 'jobs_total', 'jobs_india', 'sample_titles', 'rounds', 'tests', 'via', 'tried', 'queries', 'models', 'notes', 'alternatives'];
const rowLine = (r) => COLS.map((c) => redact(String(r[c] ?? '')).replace(/[\t\r\n]+/g, ' ').trim()).join('\t');
export const readDone2 = (text) => new Set(text.split('\n').slice(1).map((l) => l.split('\t')[0].trim().toLowerCase()).filter(Boolean));

const env = {}; // providers etc., set in main

/** Fetch an ATS board through the scan providers. Never throws. */
async function fetchBoard(url, name) {
  try {
    const entry = { name, careers_url: url };
    const pr = env.resolveProvider(entry, env.providers);
    if (!pr || pr.error) return { ok: false, why: 'no provider' };
    const jobs = await Promise.race([pr.provider.fetch({ ...entry }, env.http), sleep(30000).then(() => { throw new Error('timeout'); })]);
    const fp = boardFingerprint(jobs, env.inIndia);
    return { ok: true, total: fp.total, india: fp.india_any, sample: fp.sample.map((s) => s.title) };
  } catch (err) { return { ok: false, status: err?.status, why: String(err?.message || err).slice(0, 60) }; }
}

/** One URL, one verdict. Follows an ATS found on the page and "view jobs" style links, depth-limited. */
export async function testUrl(context, url, name, st, depth = 0) {
  mark(st.tried, url, 'testing'); st.tests++;
  st.trusted ??= new Set();
  const idOk = () => identityOk(url, name, st.trusted, atsFromUrl, slugMatchesName);
  // A pass counts only when the page is the company's: a lookalike with real jobs is recorded as unverified-identity.
  const done = (rec) => {
    if (PASSING.has(rec.verdict) || rec.verdict === 'board-empty') { if (!idOk()) rec = { ...rec, verdict: 'unverified-identity', note: `${rec.verdict}; ${rec.note || ''} identity not confirmed` }; else st.trusted.add(keyOf(url, atsFromUrl)); }
    mark(st.tried, url, rec.verdict); st.results.push({ url, ...rec }); return { url, ...rec };
  };
  const ats = atsFromUrl(url);
  if (ats) {
    const b = await fetchBoard(url, name);
    if (b.ok && b.total > 0) return done({ verdict: 'jobs-found', ats: ats.ats, total: b.total, india: b.india, sample: b.sample });
    if (b.ok) return done({ verdict: 'board-empty', ats: ats.ats, total: 0, india: 0, sample: [] });
    if (b.status === 404) return done({ verdict: 'dead-board', ats: ats.ats });
  }
  let v = await visit(context, url);
  if (!v.ok) return done({ verdict: 'unreachable', note: v.error });
  let cls = classifyPage({ status: v.status, text: v.text, links: v.links });
  if (cls.verdict === 'bot-blocked') return done({ verdict: 'bot-blocked' });
  const fromJson = (page, how) => (page.jsonJobs ? { verdict: 'listings-on-page', total: page.jsonJobs.count, located: page.jsonJobs.located, india: page.jsonJobs.india, sample: page.jsonJobs.sample, note: how } : null);
  const quick = fromJson(v, 'jobs from page data');
  if (quick) return done(quick);
  const urls = [...v.links.map((l) => l.href), ...v.frames, ...v.requests, ...extractUrls(v.html)];
  const found = pickAts(findAtsLinks(urls), name)?.best;
  if (found?.url && !seen(st.tried, found.url) && depth < 2 && st.tests < LIMITS.maxTests) {
    if (idOk()) st.trusted.add(keyOf(found.url, atsFromUrl)); // linked from the company's own page
    const sub = await testUrl(context, found.url, name, st, depth + 1);
    if (sub.verdict === 'jobs-found' || sub.verdict === 'board-empty') { st.results.push({ url, verdict: sub.verdict, via: true }); return { ...sub, via: url }; }
  }
  if (cls.verdict === 'landing' && depth < 2) {
    for (const f of followLinks(v.links, hostOf(v.finalUrl))) {
      if (seen(st.tried, f.href) || st.tests >= LIMITS.maxTests) continue;
      const sub = await testUrl(context, f.href, name, st, depth + 1);
      if (PASSING.has(sub.verdict) || sub.verdict === 'board-empty') return { ...sub, via: url };
    }
  }
  const looksOwn = ats || nameInHost(v.finalUrl, name);
  if ((cls.verdict === 'landing' || cls.verdict === 'not-careers') && cls.note !== 'page says not found' && looksOwn && depth < 2) {
    // Some portals show roles only after a search: type into their search box and read the page data again.
    const v2 = await visit(context, url, { search: 'engineer', openRoles: true, shot: Boolean(env.readListings) });
    if (v2.ok && v2.interacted) {
      const viaSearch = fromJson(v2, 'jobs after typing in the portal search box');
      if (viaSearch) return done(viaSearch);
      const c2 = classifyPage({ status: v2.status, text: v2.text, links: v2.links });
      if (c2.verdict === 'listings-on-page') return done({ verdict: 'listings-on-page', total: c2.count, sample: c2.sample, note: 'listings after typing in the portal search box' });
    }
    if (v2.ok && v2.shot && env.readListings) { // last attempt to fetch jobs: read the rendered page like a person would
      const r = await env.readListings({ company: name, url: v2.finalUrl, imageB64: v2.shot });
      if (r.model) st.models.add(r.model);
      const ok = visionListingsOk(r.value);
      if (ok) return done({ verdict: 'listings-on-page', total: ok.count, located: ok.located, india: ok.india, sample: ok.sample, note: 'jobs read from a screenshot' });
    }
  }
  if ((cls.verdict === 'landing' || cls.verdict === 'not-careers') && cls.note !== 'page says not found' && HIRING_SIGNAL.test(v.text) && looksOwn && CAREERS_PATH.test(new URL(v.finalUrl).pathname + ' ' + v.title)) return done({ verdict: 'listings-unread', note: 'careers-looking page, listings not readable', snippet: v.text.slice(0, 600), indiaMentions: (v.text.match(new RegExp(INDIA_RE.source, 'gi')) || []).length });
  const indiaMentions = (v.text.match(new RegExp(INDIA_RE.source, 'gi')) || []).length;
  return done({ verdict: cls.verdict, total: cls.count, sample: cls.sample || [], snippet: v.text.slice(0, 600), indiaMentions });
}

async function processCompany2({ context, row, rejectedUrls, llm, vision }) {
  const name = row.company;
  const st = { tried: new Map(), tests: 0, queries: [], results: [], models: new Set(), notes: [] };
  for (const u of rejectedUrls) mark(st.tried, u, 'rejected-by-user');
  st.trusted = new Set(row.status === 'accepted' && row.careers_url ? [keyOf(row.careers_url, atsFromUrl)] : []);
  const passed = () => st.results.some(indiaPass); // the only pass: India jobs fetched
  const known = env.known?.get(name.toLowerCase().replace(/[^a-z0-9]/g, '')); // a URL already in portals.yml (your verified list) is tried before any search
  if (known && !seen(st.tried, known) && known !== row.careers_url) { st.trusted.add(keyOf(known, atsFromUrl)); await testUrl(context, known, name, st); }
  for (const u of [row.careers_url].filter((u) => !passed() && /^https?:/.test(u || '') && !seen(st.tried, u))) await testUrl(context, u, name, st);
  let rounds = 0; let searchBlocked = false;
  while (!passed() && rounds < LIMITS.maxRounds && st.tests < LIMITS.maxTests) {
    rounds++;
    let queries = queryPair(name, { expectIndia: false }, rounds - 1);
    if (llm) {
      const plan = await llm.planQueries({ company: name, hint: row.notes, tried: st.results.map((r) => ({ url: r.url, verdict: r.verdict })), queries: st.queries, snippet: st.results.at(-1)?.snippet || '' });
      if (plan.model) st.models.add(plan.model);
      const fresh = (plan.value?.queries || []).filter((q) => !st.queries.includes(q));
      queries = [...queries, ...fresh.filter((q) => !queries.includes(q))]; // the fixed India pair always runs; the LLM adds to it
    }
    const pool = []; let shot = ''; let empties = 0;
    for (const q of queries.slice(0, 4)) {
      const res = await searchResults(context, q, { shot: vision && !shot });
      st.queries.push(q);
      if (!res.length) { empties++; shot = shot || res.shot || ''; }
      pool.push(...res);
    }
    if (!passed()) for (const h of [hostOf(row.careers_url || ''), String(row.domain || '').replace(/^https?:\/\//, '').replace(/[/?#].*$/, '')].filter(Boolean)) pool.push(...guessCareerUrls(h).map((url) => ({ url, title: '' }))); // search gave nothing: try the usual spots on a known host
    let cands = rankCandidates(pool, st.tried, { limit: LIMITS.perRound, companyHost: hostOf(row.careers_url || row.domain || ''), name });
    if (!cands.length && vision && llm && shot) {
      const v = await llm.seeScreenshot({ company: name, query: queries[0], imageB64: shot });
      if (v.model) st.models.add(v.model);
      const action = visionAction(v.value);
      st.notes.push(`vision:${v.value?.state || 'unavailable'}`);
      if (action === 'search-blocked') { searchBlocked = true; break; }
      if (action === 'read-urls') {
        const urls = (v.value.visible_urls || []).map((u) => (/^https?:/.test(u) ? u : `https://${u}`)).map((url) => ({ url, title: '' }));
        cands = rankCandidates(urls, st.tried, { limit: LIMITS.perRound, name });
      }
    }
    if (shouldStop({ round: rounds, tests: st.tests, newCandidates: cands.length, passed: passed() }) && !cands.length && (st.tests > 0 || rounds >= 2)) { if (empties === queries.slice(0, 4).length) st.notes.push('search-empty'); break; } // nothing tested yet: one more round with the other query pair
    for (const c of cands) { if (st.tests >= LIMITS.maxTests || passed()) break; await testUrl(context, c.url, name, st); }
  }
  // Right page, jobs read, none in India: pass 3 looks for the India version of the portal inside the same loop.
  const noIndia = st.results.find((r) => PASSING.has(r.verdict) && Number(r.india) === 0 && (r.located ?? r.total) > 0);
  if (!passed() && noIndia && !searchBlocked) {
    try {
      const { processCompany3 } = await import('./careers-pass3.mjs');
      const r3 = await processCompany3({ context, row: { company: name, careers_url: noIndia.url, jobs_india: '0', ats: noIndia.ats || '' } });
      st.notes.push(`pass3:${r3.decision}`); st.tests += Number(r3.tests) || 0;
      if (r3.decision === 'switch' && r3.new_url) st.results.push({ url: r3.new_url, verdict: 'jobs-found', ats: r3.ats, total: Number(r3.new_total) || 0, located: Number(r3.new_total) || 0, india: Number(r3.new_india) || 0, sample: [], note: 'India version found by pass 3' });
    } catch (err) { st.notes.push(`pass3-error:${String(err?.message || err).slice(0, 40)}`); }
  }
  const verdicts = st.results.map((r) => r.verdict);
  const indiaWin = [...st.results].filter(indiaPass).sort((a, b) => b.india - a.india)[0];
  const top = indiaWin ? indiaWin.verdict : best(verdicts);
  const win = indiaWin || st.results.find((r) => r.verdict === top && !r.via) || st.results.find((r) => r.verdict === top);
  let final = !verdicts.length ? (searchBlocked ? 'search-blocked' : 'no-candidate') : PASSING.has(top) || top === 'board-empty' || top === 'listings-unread' ? top : top === 'bot-blocked' ? 'bot-blocked' : top === 'unverified-identity' ? 'needs-identity-check' : 'unresolved';
  if (PASSING.has(final) && final !== 'listings-unread') final = indiaStatus(final, win); // right-portal-no-india only when locations were read; else india-unknown
  if (final === 'unresolved' && searchBlocked) final = 'search-blocked';
  // Other pages of a company with the same name where jobs were fetched: shown in the dashboard so you can pick one.
  const alternatives = st.results.filter((r) => r.url !== win?.url && Number(r.total) > 0).slice(0, 4).map((r) => ({ u: r.url, v: r.verdict, jobs: r.total ?? '', india: r.india ?? '' })); // only pages where jobs were actually fetched
  return {
    alternatives: JSON.stringify(alternatives),
    company: name, final_status: final, outcome: outcomeOf(final, win?.india), careers_url: win && final !== 'no-candidate' ? win.url : '', ats: win?.ats || '',
    jobs_total: win?.total ?? '', jobs_india: win?.india ?? '', sample_titles: (win?.sample || []).slice(0, 5).join(' | '), rounds, tests: st.tests, via: '',
    tried: JSON.stringify(st.results.slice(0, 12).map((r) => ({ u: r.url, v: r.verdict }))), queries: st.queries.join(' | '), models: [...st.models].join(','), notes: [...st.notes, win?.note ? `how:${String(win.note).slice(0, 60)}` : '', win?.indiaMentions !== undefined ? `india-mentions:${win.indiaMentions}` : ''].filter(Boolean).join(','),
  };
}

/** Providers, http context and the India location filter used to count a board's postings. */
export async function initEnv() {
  const { applyPipelineConfig } = await import('../lib/pipeline-config.mjs');
  const { buildLocationFilter } = await import('../scan.mjs');
  const { loadProviders, resolveProvider } = await import('../providers/_registry.mjs');
  const { makeHttpCtx } = await import('../providers/_http.mjs');
  const portals = existsSync(PORTALS) ? (loadYaml(read(PORTALS)) || {}) : {};
  env.known = new Map((portals.tracked_companies || []).filter((e) => e?.name && /^https?:/.test(e.careers_url || '') && e.enabled !== false).map((e) => [String(e.name).toLowerCase().replace(/[^a-z0-9]/g, ''), e.careers_url]));
  Object.assign(env, { providers: await loadProviders(join(REPO, 'providers')), resolveProvider, http: makeHttpCtx(), inIndia: buildLocationFilter(applyPipelineConfig(portals).location_filter) }); // India by the scan's location filter in portals.yml: a little miscounting is accepted

}

async function main() {
  const rows = parseTsv(read(IN) || 'company\n');
  const review = (() => { try { return JSON.parse(read(REVIEW) || '{}'); } catch { return {}; } })();
  const done = readDone2(read(OUT));
  const only = new Set((arg('--only') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  let todo = rows.filter((r) => !done.has(r.company.toLowerCase()) && (!only.size || only.has(r.company.toLowerCase())) && (has('--include-reviewed') || review[r.company]?.decision !== 'ok'));
  if (Number(arg('--limit'))) todo = todo.slice(0, Number(arg('--limit')));
  if (!todo.length) { console.log('Nothing to do.'); return 0; }
  mkdirSync(dirname(OUT), { recursive: true });
  if (!existsSync(OUT)) writeFileSync(OUT, COLS.join('\t') + '\n');
  const lock = `${OUT}.lock`;
  if (existsSync(lock)) { const pid = Number(read(lock).trim()); let alive = false; try { process.kill(pid, 0); alive = pid > 0; } catch { /* stale */ } if (alive) { console.error(`Another pass 2 run (pid ${pid}) is writing ${OUT}.`); return 1; } }
  writeFileSync(lock, String(process.pid));
  const unlock = () => { try { if (read(lock).trim() === String(process.pid)) unlinkSync(lock); } catch { /* gone */ } };
  process.on('exit', unlock); for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { unlock(); process.exit(130); });

  let llm = null;
  if (has('--llm')) {
    const keys = loadGroqKeys([...ENV_DIRS, REPO]);
    if (!keys.length) { console.error('--llm needs GROQ_API_KEY in the environment or .env'); return 1; }
    const cfgPath = join(ROOT, 'config', 'pipeline.yml');
    const c = existsSync(cfgPath) ? (loadYaml(read(cfgPath)) || {}).discovery?.llm : null;
    llm = await makeLlm({ keys, ...loadModels([...ENV_DIRS, REPO], c && typeof c === 'object' ? c : {}) });
  }
  await initEnv();
  env.readListings = llm && !has('--no-vision') ? llm.readListings : null;
  const { chromium } = await import('playwright');
  const profile = join(ROOT, 'data', 'cache', 'careers-profile-pass2');
  mkdirSync(profile, { recursive: true });
  const context = await chromium.launchPersistentContext(profile, browserLaunchOptions({ headless: true, viewport: { width: 1280, height: 900 } }));
  setSessionContext(context);
  await context.route('**/*', (route) => (['image', 'font', 'media'].includes(route.request().resourceType()) ? route.abort() : route.continue()));

  const vision = Boolean(llm) && !has('--no-vision');
  let next = 0; let stop = null; let n = 0; const counts = {};
  const pg = createProgress({ total: todo.length, label: 'pass 2', logFile: join(ROOT, 'data', 'careers-run-pass2.log'), statusFile: join(ROOT, 'data', 'careers-run-pass2.status.json') }); pg.start();
  const worker = async () => {
    while (!stop && next < todo.length) {
      const row = todo[next++];
      const rejectedUrls = review[row.company]?.decision === 'bad' ? [row.careers_url, review[row.company].careers_url].filter(Boolean) : [];
      let r;
      try {
        r = await Promise.race([processCompany2({ context, row, rejectedUrls, llm, vision }), sleep(COMPANY_DEADLINE_MS).then(() => { throw new Error('company deadline'); })]);
      } catch (err) {
        if (err instanceof Halt) { stop = stop || err; return; }
        r = { company: row.company, final_status: 'error', notes: String(err?.message || err).slice(0, 100) };
      }
      appendFileSync(OUT, rowLine(r) + '\n');
      counts[r.final_status] = (counts[r.final_status] || 0) + 1; n++;
      pg.log(`[${n}/${todo.length}] ${row.company} ${r.final_status} ${r.ats || '-'} jobs=${r.jobs_total === '' ? '-' : r.jobs_total} ${r.careers_url || ''}`.slice(0, 200));
      pg.tick(r.outcome || r.final_status);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(arg('--workers')) || 3) }, worker));
  await context.close().catch(() => {});
  pg.done('', stop ? 'halted' : 'finished');
  console.log('Summary:', JSON.stringify(counts), llm ? JSON.stringify(llm.usage) : '');
  if (stop) { console.error(`HALTED: ${stop.message}. Rerun to resume.`); return stop.code; }
  return 0;
}

if (isMainModule(import.meta.url)) main().then((c) => process.exit(c)).catch((e) => { console.error(redact(e?.stack || e)); process.exit(1); });
