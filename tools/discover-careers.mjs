#!/usr/bin/env node
/**
 * tools/discover-careers.mjs: find each company's real careers page and ATS board. Read-only: it never edits
 * portals.yml. Output is data/careers-discovery.tsv (append-only, resumable) and data/careers-discovery.status.json.
 *
 *   node tools/discover-careers.mjs                 # protected list + watch boards + check-by-hand, resume where it stopped
 *   node tools/discover-careers.mjs --limit 10      # trial
 *   node tools/discover-careers.mjs --only Razorpay,CRED
 *   node tools/discover-careers.mjs --list          # show the companies it would look at and exit
 *   node tools/discover-careers.mjs --slice1        # also every name in companies.txt slice 1
 *
 * Step 1: the company's own site. Resolve its real domain (data/company-domains.tsv, a host in portals.yml, else a guess the
 *         homepage must confirm), load the homepage and /careers in a separate headless Chrome profile with no logins, and
 *         collect ATS links (greenhouse, lever, ashby, workday, darwinbox, keka, zoho recruit, freshteam, ...) and any
 *         early-careers, campus or internship page.
 * Step 2: only if step 1 finds nothing: DuckDuckGo "<company> careers", 3-5 s between searches, stopping at a captcha.
 *         A result is accepted only when its domain matches the company.
 *
 * Judgement is code. Anything uncertain gets confidence=needs-review. No LLM calls in this version.
 * Halts (exit 2) on a captcha or rate limit, and (exit 3) after 5 consecutive companies that could not be loaded at all.
 * Run it detached: tools/run-discover.sh.
 */

import { isMainModule } from '../lib/is-main-module.mjs';
import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { loadYaml } from '../lib/yaml-document.mjs';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import {
  TSV_HEADER, toRow, readDone, buildInputs, timingReport, domainCandidates, atsFromUrl, findAtsLinks, pickAts,
  findCampusLink, findCareersLinks, extractUrls, captchaLikely, homepageMatchesCompany, hostMatchesCompany, classify,
} from '../lib/careers-discovery.mjs';

const USAGE = `usage: discover-careers.mjs [--limit N] [--only NAME,NAME] [--list] [--slice1] [--no-search] [--out PATH]
  Finds each company's real careers page and ATS board from its own website (step 1), then a web search (step 2).
  Inputs: config/protected-boards.txt, portals.yml entries with watch: true, data/check-by-hand.txt.
  Output: data/careers-discovery.tsv (append-only; rerun to resume) and data/careers-discovery.status.json.
  --slice1      also look at every name in companies.txt slice 1
  --no-search   skip step 2 (the web search)
  --list        print the companies it would look at and exit
  --help, -h    print this and exit
  Exit codes: 0 finished, 2 halted on a captcha or rate limit, 3 halted after 5 consecutive failures.`;

const ROOT = getCareerOpsRoot();
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const has = (name) => process.argv.includes(name);
const OUT = arg('--out') || join(ROOT, 'data', 'careers-discovery.tsv');
const STATUS = OUT.replace(/\.tsv$/, '.status.json');
const PROFILE_DIR = join(ROOT, 'data', 'cache', 'careers-profile');
const PORTALS = process.env.CAREER_OPS_PORTALS || join(ROOT, 'portals.yml');
const PROTECTED = process.env.CAREER_OPS_PROTECTED || join(ROOT, 'config', 'protected-boards.txt');
const CHECK_BY_HAND = process.env.CAREER_OPS_CHECK_BY_HAND || join(ROOT, 'data', 'check-by-hand.txt');
const DOMAINS_FILE = join(ROOT, 'data', 'company-domains.tsv');
const NAV_TIMEOUT = 20000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readText = (p) => (existsSync(p) ? readFileSync(p, 'utf-8') : '');

class Halt extends Error { constructor(code, reason) { super(reason); this.code = code; } }

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
  const p = join(ROOT, '..', 'companies.txt');
  const lines = readText(p).split('\n');
  const s = lines.findIndex((l) => l.includes('SLICE 1 BEGIN'));
  const e = lines.findIndex((l) => l.includes('SLICE 1 END'));
  return s >= 0 && e > s ? lines.slice(s + 1, e).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : [];
}

/** Load one page in the shared browser context. Never throws: a failed load is {ok:false}. */
async function visit(context, url) {
  const page = await context.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(1500);
    const info = await page.evaluate(() => ({
      title: document.title || '',
      siteName: document.querySelector('meta[property="og:site_name"]')?.content || '',
      text: (document.body?.innerText || '').slice(0, 6000),
      links: [...document.querySelectorAll('a[href]')].slice(0, 1500).map((a) => ({ href: a.href, text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 80) })),
      frames: [...document.querySelectorAll('iframe[src]')].map((f) => f.src),
    }));
    const html = (await page.content()).slice(0, 600000);
    return { ok: true, status: resp?.status() ?? 0, finalUrl: page.url(), html, ...info };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).split('\n')[0].slice(0, 80) };
  } finally {
    await page.close().catch(() => {});
  }
}

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };

/** Step 1. Returns the evidence found on the company's own site. */
async function ownSite(context, name, entry, overrides) {
  const hintUrl = entry?.website || (entry?.careers_url && !atsFromUrl(entry.careers_url) ? entry.careers_url : '');
  const cands = domainCandidates(name, { override: overrides.get(name.toLowerCase()), hint: hintUrl ? hostOf(hintUrl) : '' });
  const declared = overrides.has(name.toLowerCase()) ? 'override' : hintUrl ? 'portals' : 'guess';
  let pagesLoaded = 0;
  const blocked = [];
  for (const host of cands.slice(0, 6)) {
    const home = await visit(context, `https://${host}/`);
    if (!home.ok) continue;
    pagesLoaded++;
    // A company site that blocks us is a note for that company, not a reason to stop the run. Only the search engine halts it.
    if (captchaLikely(home)) { blocked.push(host); continue; }
    const verified = declared !== 'guess' || homepageMatchesCompany(home, name);
    if (!verified) continue;
    const realHost = hostOf(home.finalUrl) || host;
    const pages = [home];
    const careers = await visit(context, `https://${realHost}/careers`);
    if (careers.ok) { pagesLoaded++; if (careers.status < 400) pages.push(careers); }
    // /careers missing: follow the homepage's own careers link, once.
    if (!pages.includes(careers) || hostOf(careers.finalUrl) === realHost && careers.status >= 400) {
      const link = findCareersLinks(home.links, realHost).find((l) => !atsFromUrl(l));
      if (link) { const extra = await visit(context, link); if (extra.ok) { pagesLoaded++; if (extra.status < 400) pages.push(extra); } }
    }
    const urls = pages.flatMap((p) => [...p.links.map((l) => l.href), ...p.frames, ...extractUrls(p.html)]);
    const ats = pickAts(findAtsLinks(urls), name);
    const links = pages.flatMap((p) => p.links);
    const careersPage = pages.find((p) => p !== home && p.status < 400 && hostOf(p.finalUrl) === realHost && !/\/(404|not-found)/i.test(p.finalUrl));
    return {
      domain: realHost, domainVerified: true, domainSource: declared, pagesLoaded, ats,
      campus: findCampusLink(links), careersUrl: ats.best?.url || careersPage?.finalUrl || '', atsOnOwnSite: Boolean(ats.best), blocked,
    };
  }
  return { domain: cands[0] || '', domainVerified: false, domainSource: declared, pagesLoaded, ats: { best: null, slugOk: false, others: [] }, campus: null, careersUrl: '', atsOnOwnSite: false, blocked };
}

let lastSearchAt = 0;
/** Step 2. DuckDuckGo, polite, stops at a captcha. Accepts a result only when its domain matches the company. */
async function search(context, name, knownDomain) {
  const wait = 3000 + Math.random() * 2000 - (Date.now() - lastSearchAt);
  if (wait > 0) await sleep(wait);
  lastSearchAt = Date.now();
  const q = encodeURIComponent(`${name} careers`);
  const res = await visit(context, `https://html.duckduckgo.com/html/?q=${q}`);
  if (!res.ok) return { pagesLoaded: 0 };
  if (captchaLikely(res)) throw new Halt(2, 'captcha or rate limit on the search engine');
  const results = res.links.map((l) => {
    try { const u = new URL(l.href); const t = u.searchParams.get('uddg'); return t ? decodeURIComponent(t) : l.href; } catch { return ''; }
  }).filter((h) => /^https?:/.test(h) && !/duckduckgo\.com/.test(h)).slice(0, 10);
  for (const url of results) {
    const a = atsFromUrl(url);
    if (a) { const picked = pickAts([a], name); if (picked.slugOk) return { pagesLoaded: 1, ats: picked, careersUrl: a.url, domain: knownDomain || '' }; continue; }
    if (hostMatchesCompany(url, name, knownDomain)) return { pagesLoaded: 1, ats: { best: null, slugOk: false, others: [] }, careersUrl: url, domain: hostOf(url) };
  }
  return { pagesLoaded: 1 };
}

function writeStatus(s) {
  mkdirSync(dirname(STATUS), { recursive: true });
  const tmp = `${STATUS}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ ...s, updated_at: new Date().toISOString() }, null, 1) + '\n');
  renameSync(tmp, STATUS);
}

const COMPANY_DEADLINE_MS = Number(process.env.CAREER_OPS_COMPANY_DEADLINE_MS || 60000);
/** A page that never settles must not stall the whole run: give up on this step, record it, move on. */
function withDeadline(promise, ms, label) {
  let timer;
  const limit = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout ${ms / 1000}s (${label})`)), ms); });
  promise.catch(() => {});
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

async function main() {
  if (has('--help') || has('-h')) { console.log(USAGE); return 0; }
  const portals = existsSync(PORTALS) ? (loadYaml(readText(PORTALS)) || {}) : {};
  const entries = portals.tracked_companies || [];
  let inputs = buildInputs({
    protectedText: readText(PROTECTED), portalsEntries: entries, checkByHandText: readText(CHECK_BY_HAND),
    extraNames: has('--slice1') ? slice1Names() : [], only: (arg('--only') || '').split(',').map((s) => s.trim()).filter(Boolean),
  });
  if (has('--list')) { for (const i of inputs) console.log(`${i.name}\t${i.sources.join(',')}`); console.log(`\n${inputs.length} companies`); return 0; }
  const done = readDone(OUT);
  const todo = inputs.filter((i) => !done.has(i.name.toLowerCase()));
  const limit = Number(arg('--limit')) || 0;
  const batch = limit ? todo.slice(0, limit) : todo;
  const total = done.size + batch.length;
  if (!batch.length) { console.log(`Nothing to do: ${done.size} companies already in ${OUT}.`); return 0; }
  mkdirSync(dirname(OUT), { recursive: true });
  if (!existsSync(OUT)) writeFileSync(OUT, TSV_HEADER + '\n');

  const { chromium } = await import('playwright');
  mkdirSync(PROFILE_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, browserLaunchOptions({ headless: true, viewport: { width: 1280, height: 900 } }));
  await context.route('**/*', (route) => (['image', 'font', 'media'].includes(route.request().resourceType()) ? route.abort() : route.continue()));

  const overrides = loadDomainOverrides();
  const status = { state: 'running', started_at: new Date().toISOString(), total, done: done.size, current: null, seconds_per_company: [], first10: null, halt_reason: null };
  writeStatus(status);
  let failures = 0;
  let code = 0;
  try {
    for (const item of batch) {
      const t0 = Date.now();
      status.current = item.name;
      writeStatus(status);
      let r;
      try {
        const s1 = await withDeadline(ownSite(context, item.name, item.entry, overrides), COMPANY_DEADLINE_MS, `${item.name}: own-site step`);
        let found = s1;
        let viaSearch = false;
        if (!s1.atsOnOwnSite && !s1.careersUrl && !has('--no-search')) {
          const s2 = await withDeadline(search(context, item.name, s1.domainVerified ? s1.domain : ''), COMPANY_DEADLINE_MS, `${item.name}: search step`);
          if (s2.careersUrl) { found = { ...s1, ...s2, domain: s1.domainVerified ? s1.domain : s2.domain, campus: s1.campus, atsOnOwnSite: false }; viaSearch = true; }
          found.pagesLoaded = (s1.pagesLoaded || 0) + (s2.pagesLoaded || 0);
        }
        const verdict = classify({
          domain: found.domain, domainVerified: found.domainVerified, domainSource: found.domainSource, ats: found.ats?.best || null,
          slugOk: found.ats?.slugOk, careersUrl: found.careersUrl, atsOnOwnSite: found.atsOnOwnSite, viaSearch, pagesLoaded: found.pagesLoaded,
          atsOthers: found.ats?.others?.length || 0, blocked: found.blocked || [],
        });
        r = {
          company: item.name, domain: found.domain, careers_url: found.careersUrl, ats: found.ats?.best?.ats || (found.careersUrl ? 'custom' : ''),
          campus_url: found.campus || '', confidence: verdict.confidence, notes: [`from ${item.sources.join('+')}`, ...verdict.notes].join('; '),
        };
        failures = found.pagesLoaded ? 0 : failures + 1;
      } catch (err) {
        if (err instanceof Halt) throw err;
        failures++;
        r = { company: item.name, domain: '', careers_url: '', ats: '', campus_url: '', confidence: 'needs-review', notes: `error: ${String(err?.message || err).slice(0, 80)}` };
      }
      appendFileSync(OUT, toRow(r) + '\n');
      const secs = (Date.now() - t0) / 1000;
      status.done++;
      status.seconds_per_company.push(Math.round(secs * 10) / 10);
      console.log(`[${status.done}/${total}] ${item.name} ${r.confidence} ${r.ats || '-'} ${secs.toFixed(0)}s`);
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
    status.state = 'halted';
    status.halt_reason = err.message;
    code = err.code;
    console.error(`HALTED: ${err.message}. ${status.done} of ${total} done; rerun to resume.`);
  } finally {
    status.current = null;
    writeStatus(status);
    await context.close().catch(() => {});
  }
  return code;
}

if (isMainModule(import.meta.url)) {
  main().then((c) => process.exit(c)).catch((err) => { console.error(err?.stack || err); process.exit(1); });
}
