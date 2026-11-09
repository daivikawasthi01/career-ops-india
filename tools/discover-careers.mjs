#!/usr/bin/env node
/**
 * tools/discover-careers.mjs: find each company's real careers page and ATS board through a layered pipeline. Read-only:
 * it never edits portals.yml. Output: data/careers-discovery.tsv (append-only, resumable) + data/careers-discovery.status.json.
 *
 *   L0 code   search top 8 (title, url, snippet), homepages of the top candidates, the portals.yml board fingerprint
 *   L1 LLM    choose the official domain among the L0 candidates, or none (quote required)
 *   L2 code   DNS / HTTP / redirect / parked / bot-wall checks, 404/403/429/5xx/timeout/DNS classified, backoff retries
 *   L3 code   Playwright: careers page + ATS detection from links, iframes and network requests
 *   L4 LLM    independent verifier; sees the page and a short profile, never L1's answer
 *   L5 code   discovered ATS vs the portals.yml board; board fingerprint vs the profile
 *   L6 code   accept only when every gate agrees; otherwise retry once with different queries, then queue with reason + evidence
 *
 *   node tools/discover-careers.mjs --llm                       # the full pipeline (needs GROQ_API_KEY in .env)
 *   node tools/discover-careers.mjs                             # code only: nothing is accepted without the LLM layers
 *   node tools/discover-careers.mjs --golden tests/discover-golden.tsv --llm   # must pass before a full run
 * Run it detached: tools/run-discover.sh --llm.
 */

import { isMainModule } from '../lib/is-main-module.mjs';
import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { loadYaml } from '../lib/yaml-document.mjs';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import {
  readDone, buildInputs, timingReport, domainCandidates, atsFromUrl, findAtsLinks, pickAts, findCampusLink, findCareersLinks,
  extractUrls, captchaLikely, homepageMatchesCompany, hostMatchesCompany,
} from '../lib/careers-discovery.mjs';
import { makeLlm, loadGroqKey, loadModels } from '../lib/careers-llm.mjs';
import {
  registrable, sameSite, isAggregator, checkDomain, checkL1, quoteInEvidence, compareAts, boardFingerprint, fingerprintFit, gate, queryVariants,
} from '../lib/careers-pipeline.mjs';

const USAGE = `usage: discover-careers.mjs [--llm] [--limit N] [--only NAME,NAME] [--first FILE] [--list] [--slice1] [--golden FILE] [--skip-golden] [--out PATH]
  Layered pipeline (see the header of this file). Output: data/careers-discovery.tsv (append-only; rerun to resume).
  Inputs: config/protected-boards.txt, portals.yml entries with watch: true, data/check-by-hand.txt.
  --llm          run the Groq layers (L1 domain, L4 verifier); GROQ_API_KEY in .env, models GROQ_MODEL / GROQ_FALLBACK_MODEL
  --first FILE   look at the names in FILE before everything else
  --golden FILE  run only the cases in FILE and check them; a pass is required before a full run
  --skip-golden  start a full run without a passing golden check
  --slice1       also every name in companies.txt slice 1
  --list         print the companies it would look at and exit
  Exit codes: 0 finished, 1 error, 2 captcha or rate limit on the search engine, 3 five companies in a row with no page loaded,
  4 five LLM failures in a row, 5 golden check failed or missing.`;

const ROOT = getCareerOpsRoot();
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const has = (name) => process.argv.includes(name);
const OUT = arg('--out') || join(ROOT, 'data', 'careers-discovery.tsv');
const STATUS = OUT.replace(/\.tsv$/, '.status.json');
const GOLDEN_PASS = join(ROOT, 'data', 'careers-golden.pass.json');
const PROFILE_DIR = join(ROOT, 'data', 'cache', 'careers-profile');
const PORTALS = process.env.CAREER_OPS_PORTALS || join(ROOT, 'portals.yml');
const PROTECTED = process.env.CAREER_OPS_PROTECTED || join(ROOT, 'config', 'protected-boards.txt');
const CHECK_BY_HAND = process.env.CAREER_OPS_CHECK_BY_HAND || join(ROOT, 'data', 'check-by-hand.txt');
const DOMAINS_FILE = join(ROOT, 'data', 'company-domains.tsv');
const ENV_DIRS = [process.env.CAREER_OPS_ENV_DIR, ROOT].filter(Boolean); // a worktree or scratch root has no .env: point CAREER_OPS_ENV_DIR at the folder that has it
const REPO = join(dirname(new URL(import.meta.url).pathname), '..');
const NAV_TIMEOUT = 20000;
const COMPANY_DEADLINE_MS = Number(process.env.CAREER_OPS_COMPANY_DEADLINE_MS || 120000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readText = (p) => (existsSync(p) ? readFileSync(p, 'utf-8') : '');
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };

class Halt extends Error { constructor(code, reason) { super(reason); this.code = code; } }

const COLUMNS = ['company', 'domain', 'careers_url', 'ats', 'campus_url', 'confidence', 'notes', 'model', 'raw_decision', 'status', 'board_match', 'reason', 'evidence'];
const tsvRow = (r) => COLUMNS.map((c) => String(r[c] ?? '').replace(/[\t\r\n]+/g, ' ').trim()).join('\t');

function loadDomainOverrides() {
  const map = new Map();
  for (const line of readText(DOMAINS_FILE).split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [name, domain] = line.split('\t');
    if (name && domain) map.set(name.trim().toLowerCase(), domain.trim());
  }
  return map;
}
function slice1Names() {
  const lines = readText(join(ROOT, '..', 'companies.txt')).split('\n');
  const s = lines.findIndex((l) => l.includes('SLICE 1 BEGIN'));
  const e = lines.findIndex((l) => l.includes('SLICE 1 END'));
  return s >= 0 && e > s ? lines.slice(s + 1, e).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : [];
}
function llmConfig() {
  const p = join(ROOT, 'config', 'pipeline.yml');
  const c = existsSync(p) ? (loadYaml(readText(p)) || {}).discovery?.llm : null;
  return loadModels([...ENV_DIRS, REPO], c && typeof c === 'object' ? c : {});
}

/** Load one page. Never throws: a failed load is {ok:false}. Collects links, iframes and every request URL. */
async function visit(context, url) {
  const page = await context.newPage();
  const requests = [];
  page.on('request', (r) => { if (requests.length < 600) requests.push(r.url()); });
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(2000);
    const info = await page.evaluate(() => ({
      title: document.title || '',
      siteName: document.querySelector('meta[property="og:site_name"]')?.content || '',
      text: (document.body?.innerText || '').slice(0, 6000),
      links: [...document.querySelectorAll('a[href]')].slice(0, 1500).map((a) => ({ href: a.href, text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 80) })),
      frames: [...document.querySelectorAll('iframe[src]')].map((f) => f.src),
    }));
    const html = (await page.content()).slice(0, 600000);
    return { ok: true, status: resp?.status() ?? 0, finalUrl: page.url(), html, requests, ...info };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).split('\n')[0].slice(0, 80) };
  } finally {
    await page.close().catch(() => {});
  }
}

let lastSearchAt = 0;
/** L0 search: top 8 results with title, url, snippet. Polite (3-5 s apart); stops the run at a captcha. */
async function searchResults(context, query) {
  const wait = 3000 + Math.random() * 2000 - (Date.now() - lastSearchAt);
  if (wait > 0) await sleep(wait);
  lastSearchAt = Date.now();
  const page = await context.newPage();
  try {
    await page.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    const text = await page.evaluate(() => (document.body?.innerText || '').slice(0, 3000));
    const status = 200;
    if (captchaLikely({ status, html: text, url: page.url() })) throw new Halt(2, 'captcha or rate limit on the search engine');
    const rows = await page.evaluate(() => [...document.querySelectorAll('.result')].slice(0, 12).map((r) => ({
      title: r.querySelector('.result__a')?.innerText || '', href: r.querySelector('.result__a')?.href || '', snippet: r.querySelector('.result__snippet')?.innerText || '',
    })));
    return rows.map((r) => {
      let url = r.href;
      try { const t = new URL(r.href).searchParams.get('uddg'); if (t) url = decodeURIComponent(t); } catch { /* keep */ }
      return { title: r.title.trim(), url, snippet: r.snippet.trim() };
    }).filter((r) => /^https?:/.test(r.url) && !/duckduckgo\.com/.test(r.url)).slice(0, 8);
  } catch (err) {
    if (err instanceof Halt) throw err;
    return [];
  } finally {
    await page.close().catch(() => {});
  }
}

/** L3 on one host: homepage, /careers (or the homepage's own careers link), ATS links from links + iframes + requests. */
async function probeHost(context, host, name) {
  const home = await visit(context, `https://${host}/`);
  if (!home.ok) return { pagesLoaded: 0 };
  let pagesLoaded = 1;
  if (captchaLikely(home)) return { pagesLoaded, blocked: true };
  const realHost = hostOf(home.finalUrl) || host;
  const pages = [home];
  const careers = await visit(context, `https://${realHost}/careers`);
  if (careers.ok) { pagesLoaded++; if (careers.status < 400) pages.push(careers); }
  if (!pages.includes(careers)) {
    const link = findCareersLinks(home.links, realHost).find((l) => !atsFromUrl(l));
    if (link) { const extra = await visit(context, link); if (extra.ok) { pagesLoaded++; if (extra.status < 400) pages.push(extra); } }
  }
  const urls = pages.flatMap((p) => [...p.links.map((l) => l.href), ...p.frames, ...p.requests, ...extractUrls(p.html)]);
  const ats = pickAts(findAtsLinks(urls), name);
  const links = pages.flatMap((p) => p.links);
  const careersPage = pages.find((p) => p !== home && p.status < 400 && hostOf(p.finalUrl) === realHost && !/\/(404|not-found)/i.test(p.finalUrl));
  const shown = careersPage || home;
  return {
    pagesLoaded, host: realHost, ats, campus: findCampusLink(links) || '',
    careersUrl: ats.best?.url || careersPage?.finalUrl || '', pageUrl: shown.finalUrl, pageTitle: shown.title, pageText: shown.text,
  };
}

// ---- one company ----
const ctxFor = {}; // filled in main(): providers, http ctx, location filter

async function fingerprintOf(entry) {
  if (!entry || !ctxFor.resolveProvider) return null;
  try {
    const pr = ctxFor.resolveProvider({ ...entry }, ctxFor.providers);
    if (!pr || pr.error) return null;
    const jobs = await Promise.race([pr.provider.fetch({ ...entry }, ctxFor.http), sleep(30000).then(() => { throw new Error('timeout'); })]);
    return boardFingerprint(jobs, ctxFor.inIndia);
  } catch { return null; }
}

/** One pass of L0..L6 with one query. Returns the row fields plus `retry` when a different query could help. */
async function pass({ context, item, profile, query, overrides, llm, fp }) {
  const ev = { query };
  // L0
  const results = await searchResults(context, query);
  const cands = [];
  const add = (domain, source) => { if (domain && !cands.some((c) => sameSite(c.domain, domain))) cands.push({ domain, source, results: [] }); };
  const ov = overrides.get(item.name.toLowerCase());
  if (ov) add(ov, 'override');
  const hintUrl = item.entry?.website || (item.entry?.careers_url && !atsFromUrl(item.entry.careers_url) ? item.entry.careers_url : '');
  if (hintUrl) add(hostOf(hintUrl), 'portals');
  for (const r of results) { const h = hostOf(r.url); if (h && !atsFromUrl(r.url) && !isAggregator(h, item.name)) add(h, 'search'); }
  for (const c of cands) c.results = results.filter((r) => sameSite(hostOf(r.url), c.domain));
  if (cands.length < 3) for (const g of domainCandidates(item.name).slice(0, 3)) if (cands.length < 5) add(g, 'guess');
  const top = cands.slice(0, 5);
  for (const c of top.slice(0, 3)) { const h = await visit(context, `https://${c.domain}/`); c.homeText = h.ok ? h.text.slice(0, 800) : ''; c.loaded = h.ok; }
  ev.candidates = top.map((c) => `${c.domain}[${c.source}${c.loaded === false ? ',unreachable' : ''}]`);
  const texts = [...results.flatMap((r) => [r.title, r.snippet]), ...top.map((c) => c.homeText || '')];
  // L1
  let l1; let model = ''; let raw = '';
  if (llm) {
    const a = await llm.chooseDomain({ company: item.name, hint: profile.hint, candidates: top.filter((c) => c.loaded !== false || c.source !== 'guess') });
    model = a.model; raw = a.raw;
    if (a.value == null) llmFail.n++; else llmFail.n = 0;
    l1 = checkL1(a.value, top, texts);
  } else {
    const pick = top.find((c) => c.source === 'override' || c.source === 'portals') || null;
    l1 = pick ? { ok: true, domain: pick.domain } : { ok: false, why: 'no LLM and no domain declared in portals.yml or data/company-domains.tsv' };
  }
  ev.l1 = l1.ok ? l1.domain : l1.why;
  if (!l1.ok) return { ...early(gate({ l1 })), ev, model, raw, domain: '', retry: true };
  // L2
  const l2 = await checkDomain(l1.domain);
  ev.l2 = `${l2.class}${l2.status ? ' ' + l2.status : ''}${l2.parked ? ' parked' : ''}${l2.redirectedAway ? ' ->' + l2.finalHost : ''}`;
  if (l2.class !== 'ok' && l2.class !== '403' && l2.class !== '429') return { ...early(gate({ l1, l2 })), ev, model, raw, domain: l1.domain, retry: true };
  // L3
  const l3 = await probeHost(context, l1.domain, item.name);
  ev.l3 = l3.careersUrl || (l3.blocked ? 'blocked' : 'nothing');
  // L4 (independent: no L1 answer)
  let l4 = null; let model4 = '';
  if (llm && l3.pageText) {
    const v = await llm.verifyPage({ profile: { name: item.name, hq: profile.hq, titles: (fp?.sample || []).map((s) => s.title) }, url: l3.pageUrl, title: l3.pageTitle, text: l3.pageText });
    model4 = v.model; raw = `${raw} || ${v.raw}`;
    if (v.value == null) llmFail.n++; else llmFail.n = 0;
    const x = v.value;
    const atsClash = x && l3.ats?.best && !['custom', 'none', ''].includes(String(x.ats).toLowerCase()) && String(x.ats).toLowerCase() !== l3.ats.best.ats;
    l4 = !x ? { ok: false, why: 'verifier gave no usable answer' }
      : !x.is_company_careers_page ? { ok: false, why: 'verifier: not a careers page' }
      : x.same_company !== 'yes' ? { ok: false, why: `verifier: same company is "${x.same_company}"` }
      : x.confidence === 'low' ? { ok: false, why: 'verifier: low confidence' }
      : !quoteInEvidence(x.evidence_quote, [l3.pageText, l3.pageTitle]) ? { ok: false, why: 'verifier quote is not on the page' }
      : atsClash ? { ok: false, why: `verifier says ${x.ats}, links show ${l3.ats.best.ats}` }
      : { ok: true };
    ev.l4 = l4.ok ? 'agrees' : l4.why;
  }
  // L5
  const boardUrl = item.entry ? (item.entry.careers_url || item.entry.api || '') : '';
  const l5ats = compareAts(l3.ats?.best, boardUrl);
  const l5fp = fingerprintFit(fp, profile);
  ev.l5 = `${l5ats.state}${l5ats.detail ? ' (' + l5ats.detail + ')' : ''}; fingerprint ${l5fp.state}`;
  // L6
  const g = gate({ l1, l2, l3, l4, l5ats, l5fp }, { needLlm: Boolean(llm) });
  return { ...g, ev, model: model4 || model, raw, domain: l1.domain, l3, l5ats, retry: !g.accepted };
}
const llmFail = { n: 0 };
/** A run that stopped early reports only the first failed gate, not the layers it never reached. */
const early = (g) => ({ ...g, failed: g.failed.slice(0, 1) });

async function processCompany({ context, item, overrides, llm }) {
  const profile = { name: item.name, expectIndia: item.sources.includes('protected'), hq: item.sources.includes('protected') ? 'India (Indian-HQ or India office)' : '', hint: item.entry?.notes ? String(item.entry.notes).slice(0, 80) : '' };
  const fp = await fingerprintOf(item.entry);
  const queries = queryVariants(item.name, profile);
  const attempts = [];
  let last;
  for (let i = 0; i < 2; i++) {
    last = await pass({ context, item, profile, query: queries[i], overrides, llm, fp });
    attempts.push(last);
    if (last.accepted || !last.retry) break;
    if (llmFail.n >= 5) throw new Halt(4, '5 LLM calls in a row gave no usable answer (rate limit or API error)');
  }
  const l3 = last.l3 || {};
  const bm = last.l5ats ? last.l5ats.state : 'n/a';
  return {
    company: item.name, domain: last.domain || '', careers_url: l3.careersUrl || '', ats: l3.ats?.best?.ats || (l3.careersUrl ? 'custom' : ''), campus_url: l3.campus || '',
    confidence: last.accepted ? 'high' : 'needs-review', status: last.accepted ? 'accepted' : 'queued',
    notes: `from ${item.sources.join('+')}${attempts.length > 1 ? '; retried with a different query' : ''}`, model: last.model, raw_decision: last.raw,
    board_match: bm, reason: last.accepted ? 'all gates agree' : attempts.map((a) => a.failed.join(' / ')).join(' || ').slice(0, 400),
    evidence: attempts.map((a, i) => `[${i}] ${Object.entries(a.ev).filter(([k]) => k !== 'query').map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).join('; ')}`).join(' | ').slice(0, 700),
    pagesLoaded: attempts.reduce((n, a) => n + (a.l3?.pagesLoaded || 0), 0) + (last.domain ? 1 : 0),
  };
}

function writeStatus(s) {
  mkdirSync(dirname(STATUS), { recursive: true });
  const tmp = `${STATUS}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ ...s, updated_at: new Date().toISOString() }, null, 1) + '\n');
  renameSync(tmp, STATUS);
}
function withDeadline(promise, ms, label) {
  let timer;
  const limit = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout ${ms / 1000}s (${label})`)), ms); });
  promise.catch(() => {});
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/** Golden file: company TAB allowed_domains (|) TAB expect (accept|queue|any) TAB ats (optional). */
function readGolden(path) {
  return readText(path).split('\n').filter((l) => l.trim() && !l.startsWith('#')).slice(1).map((l) => {
    const [company, domains, expect, ats] = l.split('\t');
    return { company, domains: (domains || '').split('|').filter(Boolean), expect: expect || 'any', ats: ats || '' };
  });
}
function checkGolden(cases, rows) {
  const fails = [];
  for (const c of cases) {
    const r = rows.find((x) => x.company === c.company);
    if (!r) { fails.push(`${c.company}: no result`); continue; }
    const acc = r.status === 'accepted';
    if (acc && c.domains.length && !c.domains.some((d) => sameSite(d, r.domain))) fails.push(`${c.company}: accepted WRONG domain ${r.domain} (allowed ${c.domains.join('|')})`);
    if (acc && c.ats && r.ats !== c.ats) fails.push(`${c.company}: accepted ats ${r.ats}, expected ${c.ats}`);
    if (c.expect === 'accept' && !acc) fails.push(`${c.company}: expected accepted, got queued (${r.reason})`);
    if (c.expect === 'queue' && acc) fails.push(`${c.company}: expected queued, got accepted`);
  }
  return fails;
}

async function main() {
  if (has('--help') || has('-h')) { console.log(USAGE); return 0; }
  const portals = existsSync(PORTALS) ? (loadYaml(readText(PORTALS)) || {}) : {};
  const entries = portals.tracked_companies || [];
  const golden = arg('--golden') ? readGolden(arg('--golden')) : null;
  let inputs = golden
    ? golden.map((g) => ({ name: g.company, sources: [...(readText(PROTECTED).split('\n').some((l) => l.replace(/#.*/, '').trim().toLowerCase() === g.company.toLowerCase()) ? ['protected'] : []), 'golden'], entry: entries.find((e) => e.name?.toLowerCase() === g.company.toLowerCase()) || null }))
    : buildInputs({ protectedText: readText(PROTECTED), portalsEntries: entries, checkByHandText: readText(CHECK_BY_HAND), extraNames: has('--slice1') ? slice1Names() : [], only: (arg('--only') || '').split(',').map((s) => s.trim()).filter(Boolean) });
  if (arg('--first')) {
    const first = readText(arg('--first')).split('\n').map((l) => l.replace(/#.*/, '').split('\t')[0].trim()).filter(Boolean);
    const rank = new Map(first.map((n, i) => [n.toLowerCase(), i]));
    for (const n of first) if (!inputs.some((i) => i.name.toLowerCase() === n.toLowerCase())) inputs.push({ name: n, sources: ['first'], entry: null });
    inputs = [...inputs].sort((a, b) => (rank.get(a.name.toLowerCase()) ?? 1e9) - (rank.get(b.name.toLowerCase()) ?? 1e9));
  }
  if (has('--list')) { for (const i of inputs) console.log(`${i.name}\t${i.sources.join(',')}`); console.log(`\n${inputs.length} companies`); return 0; }
  if (!golden && !has('--skip-golden') && !existsSync(GOLDEN_PASS)) { console.error(`No passing golden check (${GOLDEN_PASS}). Run with --golden tests/discover-golden.tsv --llm first, or pass --skip-golden.`); return 5; }

  let llm = null;
  if (has('--llm')) {
    const apiKey = loadGroqKey([...ENV_DIRS, REPO]);
    if (!apiKey) { console.error('--llm needs GROQ_API_KEY in the environment or in .env'); return 1; }
    const m = llmConfig();
    llm = await makeLlm({ apiKey, ...m });
    console.log(`LLM: ${m.model}, fallback ${m.fallback}`);
  }

  const out = golden ? OUT.replace(/\.tsv$/, '.golden.tsv') : OUT;
  if (golden && existsSync(out)) renameSync(out, `${out}.${Date.now()}.bak`);
  if (existsSync(out) && readText(out).split('\n')[0] !== COLUMNS.join('\t')) renameSync(out, `${out}.legacy-${Date.now()}`);
  const done = readDone(out);
  const todo = inputs.filter((i) => !done.has(i.name.toLowerCase()));
  const limit = Number(arg('--limit')) || 0;
  const batch = limit ? todo.slice(0, limit) : todo;
  const total = done.size + batch.length;
  if (!batch.length) { console.log(`Nothing to do: ${done.size} companies already in ${out}.`); return 0; }
  mkdirSync(dirname(out), { recursive: true });
  if (!existsSync(out)) writeFileSync(out, COLUMNS.join('\t') + '\n');

  // portals.yml board fingerprints
  const { applyPipelineConfig } = await import('../lib/pipeline-config.mjs');
  const { loadProviders, resolveProvider } = await import('../providers/_registry.mjs');
  const { makeHttpCtx } = await import('../providers/_http.mjs');
  const { buildLocationFilter } = await import('../scan.mjs');
  const cfg = applyPipelineConfig(portals);
  Object.assign(ctxFor, { providers: await loadProviders(join(REPO, 'providers')), resolveProvider, http: makeHttpCtx(), inIndia: buildLocationFilter(cfg.location_filter) });

  const { chromium } = await import('playwright');
  mkdirSync(PROFILE_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, browserLaunchOptions({ headless: true, viewport: { width: 1280, height: 900 } }));
  await context.route('**/*', (route) => (['image', 'font', 'media'].includes(route.request().resourceType()) ? route.abort() : route.continue()));
  const overrides = loadDomainOverrides();
  const status = { state: 'running', started_at: new Date().toISOString(), total, done: done.size, accepted: 0, queued: 0, current: null, seconds_per_company: [], first10: null, halt_reason: null };
  writeStatus(status);
  let failures = 0; let code = 0;
  const rows = [];
  try {
    for (const item of batch) {
      const t0 = Date.now();
      status.current = item.name; writeStatus(status);
      let r;
      try {
        r = await withDeadline(processCompany({ context, item, overrides, llm }), COMPANY_DEADLINE_MS, item.name);
        failures = r.pagesLoaded ? 0 : failures + 1;
      } catch (err) {
        if (err instanceof Halt) throw err;
        failures++;
        r = { company: item.name, confidence: 'needs-review', status: 'queued', notes: `from ${item.sources.join('+')}`, reason: `error: ${String(err?.message || err).slice(0, 120)}` };
      }
      rows.push(r);
      appendFileSync(out, tsvRow(r) + '\n');
      status[r.status === 'accepted' ? 'accepted' : 'queued']++;
      const secs = (Date.now() - t0) / 1000;
      status.done++; status.seconds_per_company.push(Math.round(secs * 10) / 10);
      console.log(`[${status.done}/${total}] ${item.name} ${r.status} ${r.domain || '-'} ${r.ats || '-'} ${secs.toFixed(0)}s${r.status === 'queued' ? '  (' + String(r.reason).slice(0, 90) + ')' : ''}`);
      if (status.seconds_per_company.length === 10 && !status.first10) {
        status.first10 = timingReport(status.seconds_per_company, total - done.size);
        console.log(`First 10: ${status.first10.avg_seconds}s per company on average; about ${status.first10.estimated_total_minutes} min for all ${total - done.size}.`);
      }
      writeStatus(status);
      if (failures >= 5) throw new Halt(3, `5 consecutive companies could not be loaded (last: ${item.name})`);
      await sleep(1000);
    }
    status.state = 'finished';
  } catch (err) {
    if (!(err instanceof Halt)) throw err;
    status.state = 'halted'; status.halt_reason = err.message; code = err.code;
    console.error(`HALTED: ${err.message}. ${status.done} of ${total} done; rerun to resume.`);
  } finally {
    status.current = null;
    if (llm) { status.llm_usage = llm.usage; console.log(`LLM usage: ${llm.usage.calls} calls, ${llm.usage.input} input tokens, ${llm.usage.output} output tokens, ${llm.usage.errors} errors`); }
    writeStatus(status);
    await context.close().catch(() => {});
  }
  console.log(`Accepted ${status.accepted}, queued ${status.queued}.`);
  if (golden && code === 0) {
    const fails = checkGolden(golden, rows);
    if (fails.length) { console.error(`GOLDEN FAILED:\n  ${fails.join('\n  ')}`); return 5; }
    writeFileSync(GOLDEN_PASS, JSON.stringify({ passed_at: new Date().toISOString(), cases: golden.length, llm: Boolean(llm), accepted: status.accepted }, null, 1) + '\n');
    console.log(`GOLDEN PASSED: ${golden.length} cases.`);
  }
  return code;
}

if (isMainModule(import.meta.url)) {
  main().then((c) => process.exit(c)).catch((err) => { console.error(err?.stack || err); process.exit(1); });
}
export { checkGolden, readGolden };
