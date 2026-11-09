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

import { createProgress } from '../lib/progress.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { execFileSync } from 'child_process';
import { jobsFromJson, bestJsonJobs } from '../lib/careers-pass2.mjs';
import { loadYaml } from '../lib/yaml-document.mjs';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import {
  readDone, buildInputs, timingReport, domainCandidates, atsFromUrl, findAtsLinks, pickAts, findCampusLink, findCareersLinks,
  extractUrls, captchaLikely, homepageMatchesCompany, hostMatchesCompany,
} from '../lib/careers-discovery.mjs';
import { makeLlm, loadGroqKeys, loadModels, domainPrompt } from '../lib/careers-llm.mjs';
import { loadGeminiKeys, loadGeminiModel } from '../lib/careers-gemini.mjs';
import { claudeEnabled, claudeModel } from '../lib/careers-claude.mjs';
import {
  registrable, sameSite, isAggregator, checkDomain, checkL1, quoteInEvidence, compareAts, boardFingerprint, fingerprintFit, gate, queryPair, redact, unwrapBingUrl, SearchGovernor, failureBackoff,
} from '../lib/careers-pipeline.mjs';

const USAGE = `usage: discover-careers.mjs [--llm] [--limit N] [--only NAME,NAME] [--first FILE] [--list] [--slice1] [--workers N] [--search-lanes N] [--no-headed] [--all] [--companies FILE] [--golden FILE] [--out PATH]
  Layered pipeline (see the header of this file). Output: data/careers-discovery.tsv (append-only; rerun to resume).
  Inputs: config/protected-boards.txt, portals.yml entries with watch: true, data/check-by-hand.txt.
  --llm          run the Groq layers (L1 domain, L4 verifier); GROQ_API_KEY in .env, models GROQ_MODEL / GROQ_FALLBACK_MODEL
  --first FILE   look at the names in FILE before everything else
  --companies F  also run every name in F (one per line, # comments), in file order, after the lists above
  --all          every enabled company in portals.yml, plus the protected, watch and check-by-hand lists
  --golden FILE  run only the cases in FILE and check them; a pass is required before a full run
  (debug) CAREER_OPS_UNVALIDATED=1 starts a full run without a passing golden check; every row is then stamped "unvalidated"
  --slice1       also every name in companies.txt slice 1
  --list         print the companies it would look at and exit
  Exit codes: 0 finished, 1 error, 2 captcha or rate limit on the search engine, 3 five companies in a row with no page loaded,
  4 five LLM failures in a row, 5 golden check failed or missing.`;

const ROOT = getCareerOpsRoot();
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const has = (name) => process.argv.includes(name);
const OUT = arg('--out') || join(ROOT, 'data', 'careers-discovery.tsv');
const STATUS = OUT.replace(/\.tsv$/, '.status.json');
const MIN_CONFIRMED = 10;
const GOLDEN_PASS = join(ROOT, 'data', 'careers-golden.pass.json');
const PROFILE_DIR = join(ROOT, 'data', 'cache', 'careers-profile');
const PORTALS = process.env.CAREER_OPS_PORTALS || join(ROOT, 'portals.yml');
const PROTECTED = process.env.CAREER_OPS_PROTECTED || join(ROOT, 'config', 'protected-boards.txt');
const CHECK_BY_HAND = process.env.CAREER_OPS_CHECK_BY_HAND || join(ROOT, 'data', 'check-by-hand.txt');
const DOMAINS_FILE = join(ROOT, 'data', 'company-domains.tsv');
const ENV_DIRS = [process.env.CAREER_OPS_ENV_DIR, ROOT].filter(Boolean); // a worktree or scratch root has no .env: point CAREER_OPS_ENV_DIR at the folder that has it
const REPO = join(dirname(new URL(import.meta.url).pathname), '..');
const NAV_TIMEOUT = 20000;
const COMPANY_DEADLINE_MS = Number(process.env.CAREER_OPS_COMPANY_DEADLINE_MS || 300000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readText = (p) => (existsSync(p) ? readFileSync(p, 'utf-8') : '');
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };

class Halt extends Error { constructor(code, reason) { super(reason); this.code = code; } }

const COLUMNS = ['company', 'domain', 'careers_url', 'ats', 'campus_url', 'confidence', 'notes', 'model', 'raw_decision', 'status', 'board_match', 'reason', 'evidence', 'validation'];
const tsvRow = (r) => COLUMNS.map((c) => redact(String(r[c] ?? '')).replace(/[\t\r\n]+/g, ' ').trim()).join('\t');

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

const CONSENT_SELECTORS = ['#onetrust-accept-btn-handler', '#accept-recommended-btn-handler', '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', '#truste-consent-button', '.cc-allow', '.cc-dismiss', 'button[id*="accept" i][id*="cookie" i]', '[class*="cookie" i] button[class*="accept" i]', '[aria-label*="accept all" i]'];
const CONSENT_TEXT = /^(accept( all)?( cookies)?|allow( all)?( cookies)?|i agree|agree|got it|ok(ay)?|accept (and|&) close|yes,? i agree|continue)$/i;
/** Click a cookie or consent banner away so the page behind it can be read. Short, best effort, never throws. Returns true if something was clicked. */
export async function dismissConsent(page) {
  const deadline = Date.now() + 3000;
  const targets = [page, ...page.frames().filter((f) => f !== page.mainFrame()).slice(0, 4)];
  for (const target of targets) {
    for (const sel of CONSENT_SELECTORS) {
      if (Date.now() > deadline) return false;
      try { const el = target.locator(sel).first(); if (await el.isVisible({ timeout: 150 })) { await el.click({ timeout: 800 }); return true; } } catch { /* next */ }
    }
    try { const b = target.getByRole('button', { name: CONSENT_TEXT }).first(); if (await b.isVisible({ timeout: 200 })) { await b.click({ timeout: 800 }); return true; } } catch { /* none */ }
  }
  return false;
}
/** Button or link text that reveals the job list: "Show open roles", "View all jobs", "Explore openings". */
export const OPEN_ROLES_RE = /^(?:(?:show|view|see|explore|browse|check|find)\s+(?:all\s+|our\s+|the\s+)*(?:open|current|available)?\s*(?:roles?|jobs?|positions?|openings?|vacancies)|open\s+(?:roles?|positions?|jobs?|openings?|vacancies))\s*(?:→|>|»)?$/i;
async function clickOpenRoles(page) {
  try {
    const els = await page.$$('button, a, [role="button"]');
    for (const el of els.slice(0, 120)) {
      const t = ((await el.innerText().catch(() => '')) || '').trim().replace(/\s+/g, ' ');
      if (t && t.length < 40 && OPEN_ROLES_RE.test(t) && await el.isVisible().catch(() => false)) { await el.click({ timeout: 2000 }); await page.waitForTimeout(3500); return true; }
    }
  } catch { /* none */ }
  return false;
}
/** Type a query into the page's own search box and press Enter (portals that show roles only after a search). */
async function searchInPage(page, query) {
  const inputs = ['input[type="search"]', '[role="searchbox"]', 'input[placeholder*="search" i]', 'input[aria-label*="search" i]', 'input[name*="keyword" i]', 'input[name="q"]', 'input[id*="search" i]', 'input[placeholder*="job title" i]', 'input[placeholder*="keyword" i]'];
  for (const sel of inputs) {
    try {
      const el = page.locator(sel).first();
      if (!(await el.isVisible({ timeout: 200 }))) continue;
      await el.fill(query, { timeout: 1500 }); await el.press('Enter', { timeout: 1000 });
      await page.waitForTimeout(3500);
      return true;
    } catch { /* next input */ }
  }
  return false;
}

/** Load one page. Never throws: a failed load is {ok:false}. Collects links, iframes and every request URL. */
async function visit(context, url, opts = {}) {
  const page = await context.newPage();
  const requests = [];
  const json = [];
  page.on('request', (r) => { if (requests.length < 600) requests.push(r.url()); });
  page.on('response', async (resp) => { // job lists often arrive as JSON after the page loads
    try {
      if (json.length >= 12 || !/json/i.test(resp.headers()['content-type'] || '')) return;
      const body = await resp.text(); if (body.length > 3_000_000) return;
      const jobs = jobsFromJson(JSON.parse(body)); if (jobs) json.push(jobs);
    } catch { /* not json, or gone */ }
  });
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(2000);
    if (await dismissConsent(page)) await page.waitForTimeout(800);
    let interacted = false;
    if (opts.openRoles) interacted = (await clickOpenRoles(page)) || interacted;
    if (opts.search) interacted = (await searchInPage(page, opts.search)) || interacted;
    const info = await page.evaluate(() => ({
      title: document.title || '',
      siteName: document.querySelector('meta[property="og:site_name"]')?.content || '',
      text: (document.body?.innerText || '').slice(0, 6000),
      links: [...document.querySelectorAll('a[href]')].slice(0, 1500).map((a) => ({ href: a.href, text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 80) })),
      frames: [...document.querySelectorAll('iframe[src]')].map((f) => f.src),
    }));
    const html = (await page.content()).slice(0, 600000);
    const shot = opts.shot ? (await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => Buffer.alloc(0))).toString('base64') : '';
    return { ok: true, status: resp?.status() ?? 0, finalUrl: page.url(), html, requests, jsonJobs: bestJsonJobs(json), interacted, shot, ...info };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).split('\n')[0].slice(0, 80) };
  } finally {
    await page.close().catch(() => {});
  }
}

let lastSearchAt = 0;
/** L0 search: top 8 results with title, url, snippet. Polite (3-5 s apart); stops the run at a captcha. */
const ENGINES = [
  { name: 'bing', url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&cc=IN&setmkt=en-IN`,
    read: () => [...document.querySelectorAll('li.b_algo')].slice(0, 10).map((r) => ({ title: r.querySelector('h2')?.innerText || '', href: r.querySelector('h2 a')?.href || '', snippet: r.querySelector('.b_caption p, p')?.innerText || '' })) },
  { name: 'duckduckgo', url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=in-en`,
    read: () => [...document.querySelectorAll('.result')].slice(0, 12).map((r) => ({ title: r.querySelector('.result__a')?.innerText || '', href: r.querySelector('.result__a')?.href || '', snippet: r.querySelector('.result__snippet')?.innerText || '' })) },
];
const searchStats = { empty: 0, calls: 0 };
// Search lanes, paced by a governor: a block halves the lanes and pauses; good searches bring them back slowly.
const LANES = Math.max(1, Number(arg('--search-lanes')) || 3);
const gov = new SearchGovernor({ lanes: LANES });
const lanes = Array.from({ length: LANES }, () => ({ chain: Promise.resolve(), last: 0 }));
let laneTurn = 0;
let solving = null; // a promise while a human is solving a captcha
let sessionContext = null; // the headless context, set in main
const notify = (msg) => { try { if (process.platform === 'darwin') execFileSync('osascript', ['-e', `display notification ${JSON.stringify(msg)} with title "Careers discovery"`]); } catch { /* no notification */ } };
/** Step 2: a visible browser window; the person solves the captcha; the cookies move to the headless session. */
async function solveByHand() {
  const { chromium: pw } = await import('playwright');
  notify('Search captcha: solve it in the Chrome window (waiting up to 10 minutes)');
  console.error('[search] opening a visible browser: solve the captcha there (waiting up to 10 minutes)');
  const b = await pw.launch({ headless: false });
  try {
    const ctx = await b.newContext(); const page = await ctx.newPage();
    await page.goto('https://www.bing.com/search?q=careers', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
    for (let i = 0; i < 200; i++) {
      const n = await page.evaluate(() => document.querySelectorAll('li.b_algo').length).catch(() => 0);
      if (n > 0) { await (await searchCtx(sessionContext)).addCookies(await ctx.cookies()); return true; }
      await sleep(3000);
    }
    return false;
  } finally { await b.close().catch(() => {}); }
}
const searchTurn = async () => {
  if (solving) await solving;
  const pause = gov.pauseMs();
  if (pause) await sleep(pause);
  const lane = lanes[laneTurn++ % gov.active];
  const p = lane.chain.then(async () => { const wait = gov.spacingMs() - (Date.now() - lane.last); if (wait > 0) await sleep(wait); lane.last = Date.now(); });
  lane.chain = p.catch(() => {});
  return p;
};
/** Top results from the first engine that returns any. Zero results from every engine is reported as an empty search, never as "no candidates". */
// Searches run in their own browser, thrown away and replaced after every block and every 40 searches: a throttled or flagged session
// (cookies, state) is never reused. The page loads keep their own persistent context.
let searchBrowser = null; let searchCtxObj = null; let searchesInSession = 0;
async function searchCtx(fallback) {
  if (!searchCtxObj) {
    try { const { chromium: pw } = await import('playwright'); searchBrowser = await pw.launch(browserLaunchOptions({ headless: true })); searchCtxObj = await searchBrowser.newContext({ locale: 'en-IN' }); searchesInSession = 0; } catch { return fallback; }
  }
  return searchCtxObj;
}
async function freshSearchSession() {
  const c = searchCtxObj; const b = searchBrowser; searchCtxObj = null; searchBrowser = null;
  // other lanes may be mid-search in the old browser: close it a little later, new searches already use the new one
  setTimeout(() => { c?.close().catch(() => {}); b?.close().catch(() => {}); }, 30000).unref();
}
/** Result rows that carry links but almost no title text: a throttled page, not results. */
export const isHollowResults = (rs) => rs.length > 0 && rs.filter((r) => String(r.title || '').trim().length > 3).length < Math.min(3, rs.length);
/** Bing's RSS output (format=rss): plain XML with direct result links, no page to render. Returns [{ title, url, snippet }]. */
export function parseBingRss(xml) {
  const un = (s) => String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/<[^>]+>/g, '').trim();
  const out = [];
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const pick = (tag) => un(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(m[1])?.[1]);
    const url = pick('link');
    let host = ''; try { host = new URL(url).hostname; } catch { continue; }
    if (!/^https?:/.test(url) || /(^|\.)bing\.com$/.test(host)) continue;
    out.push({ title: pick('title'), url, snippet: pick('description') });
  }
  return out.slice(0, 8);
}
/** Decoy check: does any result mention a word of the company name (from the query)? Bing hands out unrelated pages when it throttles. */
export function mentionsQueryName(query, rows) {
  const words = String(query).toLowerCase().replace(/"/g, ' ').split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !/^(careers?|india|sde|jobs?|the|and|group|limited|ltd|inc|corp)$/.test(w));
  if (!words.length) return true;
  return rows.some((r) => { const t = `${r.title} ${r.url} ${r.snippet}`.toLowerCase().replace(/[^a-z0-9]+/g, ''); return words.some((w) => t.includes(w)); });
}
let rssFailLogged = 0;
async function rssSearch(query) {
  let why = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&setmkt=en-IN&cc=IN`, { signal: AbortSignal.timeout(20000), headers: { 'accept-language': 'en-IN,en;q=0.9' } });
      const text = await res.text();
      const rows = res.ok ? parseBingRss(text) : [];
      if (rows.length && mentionsQueryName(query, rows)) return rows;
      if (rows.length) { searchStats.decoy = (searchStats.decoy || 0) + 1; return Object.assign([], { decoy: true }); } // junk for this query: no retry, no pause
      why = `HTTP ${res.status}, ${text.length} bytes, ${(text.match(/<item>/g) || []).length} items, starts "${text.replace(/\s+/g, ' ').slice(0, 80)}"`;
    } catch (err) { why = `fetch failed: ${err?.cause?.code || err?.message || err}`; }
    await sleep(2000);
  }
  searchStats.rssFail = (searchStats.rssFail || 0) + 1;
  if (rssFailLogged++ < 5) console.error(`[search] RSS gave nothing for "${String(query).slice(0, 40)}": ${why}`);
  return [];
}
async function searchResults(context, query, opts = {}) {
  let shot = '';
  await searchTurn(); // searches are spaced out across all workers
  searchStats.calls++;
  let reason = 'empty';
  // First choice: Bing RSS over plain HTTP (no browser session to get flagged). Only if it returns nothing do we open pages.
  const rss = await rssSearch(query);
  if (rss.length) { rss.engine = 'bing-rss'; gov.ok(); return rss; }
  // Bing answered, but with pages that are not about this company (this query only). Not a block: no pause, the next query variant tries again.
  if (rss.decoy) reason = 'decoy results'; // not a block by itself: the browser pages get a try below
  if (++searchesInSession > 40) await freshSearchSession();
  const sc = await searchCtx(context);
  for (const eng of ENGINES) {
    const page = await sc.newPage();
    try {
      await page.goto(eng.url(query), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      const text = await page.evaluate(() => (document.body?.innerText || '').slice(0, 3000));
      if (captchaLikely({ status: 200, html: text, url: page.url() })) { reason = 'captcha'; continue; }
      let rows = await page.evaluate(eng.read);
      // Bing sometimes returns the result rows with no text (a throttled, hollow page). Links without titles are not results: wait once, read again,
      // and otherwise treat the engine as blocked so the next one is tried and the governor slows down.
      if (isHollowResults(rows)) { await page.waitForTimeout(4000); rows = await page.evaluate(eng.read); }
      if (isHollowResults(rows)) { searchStats.hollow = (searchStats.hollow || 0) + 1; reason = 'hollow rows'; continue; }
      const out = rows.map((r) => {
        let url = unwrapBingUrl(r.href);
        try { const t = new URL(r.href).searchParams.get('uddg'); if (t) url = decodeURIComponent(t); } catch { /* keep */ }
        return { title: r.title.trim(), url, snippet: r.snippet.trim() };
      }).filter((r) => /^https?:/.test(r.url) && !/(duckduckgo|bing)\.com/.test(new URL(r.url).hostname)).slice(0, 8);
      if (out.length && !mentionsQueryName(query, out)) { reason = 'decoy results'; continue; }
      if (out.length) { out.engine = eng.name; gov.ok(); return out; }
      if (opts.shot && !shot) shot = (await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => Buffer.alloc(0))).toString('base64');
    } catch (err) {
      if (err instanceof Halt) throw err;
    } finally {
      await page.close().catch(() => {});
    }
  }
  searchStats.empty++;
  if (reason === 'decoy results') { const none = []; none.engine = 'decoy'; none.shot = shot; return none; } // junk for this query only: no pause, the next query variant tries again
  gov.blocked();
  await freshSearchSession(); // step 1, on every block: a brand new browser, nothing carried over
  if (gov.blocksInRow >= 2 && !solving && !has('--no-headed') && !process.env.CAREER_OPS_NO_HEADED) { // step 2: a person solves it
    solving = solveByHand().finally(() => { solving = null; });
    if (await solving) { gov.reset(); console.error('[search] captcha solved by hand; carrying on gently'); }
  }
  console.error(`[search] blocked or empty (${reason}) on "${String(query).slice(0, 40)}": fresh browser next; ${gov.active}/${gov.maxLanes} lanes, +${gov.extraMs} ms spacing, pause ${Math.round(gov.pauseMs() / 1000)} s (${gov.blocksInRow} in a row)`);
  if (gov.shouldHalt()) throw new Halt(2, `search engines returned nothing ${gov.blocksInRow} times in a row, even after cooling down`);
  const none = []; none.engine = 'none'; none.shot = shot;
  return none;
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

/** Official-website (P856) of the top Wikidata matches for a name. Network failure gives []. */
async function wikidataSites(name) {
  const get = async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'career-ops-discovery/1.0' } }); return r.json(); };
  try {
    const s = await get(`https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&limit=3&search=${encodeURIComponent(name)}`);
    const hits = (s.search || []).slice(0, 3);
    if (!hits.length) return [];
    const e = await get(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims&ids=${hits.map((h) => h.id).join('|')}`);
    const out = [];
    for (const h of hits) {
      const url = e.entities?.[h.id]?.claims?.P856?.[0]?.mainsnak?.datavalue?.value;
      if (typeof url === 'string' && /^https?:/.test(url)) out.push({ title: `Wikidata official website: ${h.label} (${h.description || 'no description'})`, url, snippet: 'official website property on Wikidata' });
    }
    return out;
  } catch { return []; }
}

/** One pass of L0..L6 with one query. Returns the row fields plus `retry` when a different query could help. */
async function pass({ context, item, profile, queries, overrides, llm, fp }) {
  const ev = { query: queries.join(' + ') };
  // L0
  const results = [];
  // A domain you declared (portals.yml or the overrides file) needs no search and no model: skip both, the later checks still run.
  const declaredHost = overrides.get(item.name.toLowerCase()) || hostOf(item.entry?.website || (item.entry?.careers_url && !atsFromUrl(item.entry.careers_url) ? item.entry.careers_url : ''));
  if (!declaredHost) {
    for (const q of queries) for (const r of await searchResults(context, q)) if (!results.some((x) => x.url === r.url)) results.push(r);
    // Seed from Wikidata's official-website property: retrieved evidence, not model memory.
    for (const w of await wikidataSites(item.name)) if (!results.some((x) => sameSite(hostOf(x.url), hostOf(w.url)))) results.push(w);
  }
  // No search results is not the end: guessed domains from the name are still candidates (the model and the page checks decide).
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
  if (!top.length) return { ...early(gate({ l1: { ok: false, why: 'search returned no results from any engine, so no candidates were gathered' } })), ev, model: '', raw: '', domain: '', retry: true };
  for (const c of top.slice(0, 3)) { const h = await visit(context, `https://${c.domain}/`); c.homeText = h.ok ? h.text.slice(0, 800) : ''; c.loaded = h.ok; }
  ev.candidates = top.map((c) => `${c.domain}[${c.source}${c.loaded === false ? ',unreachable' : ''}]`);
  const texts = [];
  // L1
  let l1; let model = ''; let raw = ''; const fb = {}; const by = {};
  if (llm && !declaredHost) {
    const shown = { company: item.name, hint: profile.hint, candidates: top.filter((c) => c.loaded !== false || c.source !== 'guess') };
    texts.push(domainPrompt(shown)); // the quote must occur in exactly what the model was shown
    const a = await llm.chooseDomain(shown);
    model = a.model; raw = a.raw; fb.l1 = a.fallback; by.l1 = a.model;
    if (a.value == null) llmFail.n++; else llmFail.n = 0;
    l1 = checkL1(a.value, top, texts);
    // A domain you declared (portals.yml or the overrides file) needs no search evidence: when the model finds nothing among decoy
    // search results, use the declared one. The domain, page and identity checks below still have to agree.
    if (!l1.ok && l1.none) { const decl = top.find((c) => (c.source === 'override' || c.source === 'portals') && c.loaded !== false); if (decl) l1 = { ok: true, domain: decl.domain, declared: true }; }
  } else {
    const pick = top.find((c) => c.source === 'override' || c.source === 'portals') || null;
    l1 = pick ? { ok: true, domain: pick.domain } : { ok: false, why: 'no LLM and no domain declared in portals.yml or data/company-domains.tsv' };
  }
  ev.l1 = l1.ok ? l1.domain : l1.why;
  if (!l1.ok) return { ...early(gate({ l1 })), ev, model: by.l1 ? `L1:${by.l1}` : '', raw, domain: '', retry: true };
  // L2
  const l2 = await checkDomain(l1.domain);
  ev.l2 = `${l2.class}${l2.status ? ' ' + l2.status : ''}${l2.parked ? ' parked' : ''}${l2.redirectedAway ? ' ->' + l2.finalHost : ''}`;
  if (l2.class !== 'ok' && l2.class !== '403' && l2.class !== '429') return { ...early(gate({ l1, l2 })), ev, model: by.l1 ? `L1:${by.l1}` : '', raw, domain: l1.domain, retry: true };
  // L3
  const l3 = await probeHost(context, l1.domain, item.name);
  ev.l3 = l3.careersUrl || (l3.blocked ? 'blocked' : 'nothing');
  // L4 (independent: no L1 answer)
  let l4 = null; let model4 = '';
  if (llm && l3.pageText) {
    const v = await llm.verifyPage({ profile: { name: item.name, hq: profile.hq, titles: (fp?.sample || []).map((s) => s.title) }, url: l3.pageUrl, title: l3.pageTitle, text: l3.pageText });
    model4 = v.model; raw = `${raw} || ${v.raw}`; fb.l4 = v.fallback; by.l4 = v.model;
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
  const g = gate({ l1, l2, l3, l4, l5ats, l5fp, fb }, { needLlm: Boolean(llm) });
  return { ...g, ev, model: Object.entries(by).map(([k, v]) => `${k.toUpperCase()}:${v}`).join(';'), raw, domain: l1.domain, l3, l5ats, retry: !g.accepted };
}
const llmFail = { n: 0 };
/** A run that stopped early reports only the first failed gate, not the layers it never reached. */
const early = (g) => ({ ...g, failed: g.failed.slice(0, 1) });

async function processCompany({ context, item, overrides, llm }) {
  const profile = { name: item.name, expectIndia: item.sources.includes('protected'), hq: item.sources.includes('protected') ? 'India (Indian-HQ or India office)' : '', hint: item.entry?.notes ? String(item.entry.notes).slice(0, 80) : '' };
  const fp = await fingerprintOf(item.entry);
  const attempts = [];
  let last;
  for (let i = 0; i < 2; i++) {
    last = await pass({ context, item, profile, queries: queryPair(item.name, profile, i), overrides, llm, fp });
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

/**
 * Golden file: company TAB confirmed_domains (|) TAB expect TAB ats. Only the user's confirmed values count as truth.
 * expect: unknown (nothing confirmed yet: the row must be queued), accept, queue, any. Confirmed domains are an allowed set.
 */
function readGolden(path) {
  return readText(path).split('\n').filter((l) => l.trim() && !l.startsWith('#')).slice(1).map((l) => {
    const [company, domains, expect, ats] = l.split('\t');
    return { company, domains: (domains || '').split('|').filter(Boolean), expect: expect || 'unknown', ats: ats || '' };
  });
}
function checkGolden(cases, rows) {
  const fails = [];
  for (const c of cases) {
    const r = rows.find((x) => x.company === c.company);
    if (!r) { fails.push(`${c.company}: no result`); continue; }
    const acc = r.status === 'accepted';
    if (c.expect === 'unknown' && acc) fails.push(`${c.company}: expectation unconfirmed, so the row must be queued, but it was accepted (${r.domain} ${r.ats})`);
    if (c.expect !== 'unknown' && acc && !c.domains.length) fails.push(`${c.company}: accepted with no confirmed domain to check against`);
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
    : buildInputs({ protectedText: readText(PROTECTED), portalsEntries: entries, checkByHandText: readText(CHECK_BY_HAND), extraNames: [...(has('--slice1') ? slice1Names() : []), ...(arg('--companies') ? readText(arg('--companies')).split('\n').map((l) => l.replace(/#.*/, '').split('\t')[0].trim()).filter(Boolean) : []), ...(has('--all') ? entries.filter((e) => e && typeof e.name === 'string' && e.enabled !== false).map((e) => e.name) : [])], only: (arg('--only') || '').split(',').map((s) => s.trim()).filter(Boolean) });
  if (arg('--first')) {
    const first = readText(arg('--first')).split('\n').map((l) => l.replace(/#.*/, '').split('\t')[0].trim()).filter(Boolean);
    const rank = new Map(first.map((n, i) => [n.toLowerCase(), i]));
    for (const n of first) if (!inputs.some((i) => i.name.toLowerCase() === n.toLowerCase())) inputs.push({ name: n, sources: ['first'], entry: null });
    inputs = [...inputs].sort((a, b) => (rank.get(a.name.toLowerCase()) ?? 1e9) - (rank.get(b.name.toLowerCase()) ?? 1e9));
  }
  if (has('--list')) { for (const i of inputs) console.log(`${i.name}\t${i.sources.join(',')}`); console.log(`\n${inputs.length} companies`); return 0; }
  const unvalidated = !golden && !existsSync(GOLDEN_PASS);
  if (unvalidated && process.env.CAREER_OPS_UNVALIDATED !== '1') { console.error(`No passing golden check (${GOLDEN_PASS}). Run with --golden tests/discover-golden.tsv --llm first.`); return 5; }
  const validation = golden ? (goldenVerdict(golden, []).enough ? 'golden-run' : 'golden-unconfirmed') : unvalidated ? 'unvalidated' : 'golden-passed';

  let llm = null;
  if (has('--llm')) {
    const keys = loadGroqKeys([...ENV_DIRS, REPO]);
    if (!keys.length) { console.error('--llm needs GROQ_API_KEY (or GROQ_API_KEYS, GROQ_API_KEY_2 ...) in the environment or in .env'); return 1; }
    const m = llmConfig();
    const gk = loadGeminiKeys([...ENV_DIRS, REPO]); const gm = loadGeminiModel([...ENV_DIRS, REPO]);
    llm = await makeLlm({ keys, geminiKeys: gk, geminiModel: gm, claudeModel: claudeEnabled() ? claudeModel() : '', ...m });
    console.log(`LLM: ${m.model}, then ${gk.length ? `gemini:${gm} (${gk.length} key(s)), then ` : ''}fallback ${m.fallback}${claudeEnabled() ? `, last resort claude -p (${claudeModel()})` : ''}, ${keys.length} Groq key(s)`);
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
  // One run per output file: a second process would process the same companies again.
  const lock = `${out}.lock`;
  if (existsSync(lock)) {
    const pid = Number(readText(lock).trim());
    let alive = false; try { process.kill(pid, 0); alive = pid > 0; } catch { /* stale lock */ }
    if (alive) { console.error(`Another discovery run (pid ${pid}) is writing ${out}. Stop it first.`); return 1; }
  }
  writeFileSync(lock, String(process.pid));
  const unlock = () => { try { if (readText(lock).trim() === String(process.pid)) unlinkSync(lock); } catch { /* gone */ } };
  process.on('exit', unlock);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { unlock(); process.exit(130); });

  // portals.yml board fingerprints
  const { applyPipelineConfig } = await import('../lib/pipeline-config.mjs');
  const { loadProviders, resolveProvider } = await import('../providers/_registry.mjs');
  const { makeHttpCtx } = await import('../providers/_http.mjs');
  const { buildLocationFilter } = await import('../scan.mjs');
  const cfg = applyPipelineConfig(portals);
  Object.assign(ctxFor, { providers: await loadProviders(join(REPO, 'providers')), resolveProvider, http: makeHttpCtx(), inIndia: buildLocationFilter(cfg.location_filter) });

  const { chromium } = await import('playwright');
  mkdirSync(PROFILE_DIR, { recursive: true });
  const context = sessionContext = await chromium.launchPersistentContext(PROFILE_DIR, browserLaunchOptions({ headless: true, viewport: { width: 1280, height: 900 } }));
  await context.route('**/*', (route) => (['image', 'font', 'media'].includes(route.request().resourceType()) ? route.abort() : route.continue()));
  const overrides = loadDomainOverrides();
  const status = { state: 'running', started_at: new Date().toISOString(), total, done: done.size, accepted: 0, queued: 0, current: null, seconds_per_company: [], first10: null, halt_reason: null };
  writeStatus(status);
  let failures = 0; let code = 0; let cooldowns = 0; let pausedUntil = 0;
  const rows = [];
  const pg = createProgress({ total: batch.length, label: 'pass 1', logFile: join(dirname(out), 'careers-run-pass1.log'), statusFile: join(dirname(out), 'careers-run-pass1.status.json') }); pg.start();
  try {
    let next = 0; let stop = null;
    const WORKERS = Math.max(1, Number(arg('--workers')) || 3);
    const worker = async () => {
      while (!stop && next < batch.length) {
        while (!stop && Date.now() < pausedUntil) await sleep(5000); // a shared cooldown after a run of failures
        if (llm) { // every key limited on both models: a short wait is slept through, a daily limit stops the run with the reset time
          const until = llm.limitedUntil();
          if (until - Date.now() > 300000) { try { writeFileSync(join(dirname(out), 'careers-llm-resume.txt'), String(Math.ceil(until / 1000))); } catch { /* ignore */ } stop = stop || new Halt(4, `LLM limits reached on every key; they reset at ${new Date(until).toLocaleTimeString()}`); return; }
          if (until > Date.now()) await sleep(until - Date.now() + 1000);
        }
        const item = batch[next++];
        const t0 = Date.now();
        status.current = item.name;
        let r;
        try {
          r = await withDeadline(processCompany({ context, item, overrides, llm }), COMPANY_DEADLINE_MS, item.name);
          failures = r.pagesLoaded ? 0 : failures + 1;
          if (r.pagesLoaded) cooldowns = 0;
        } catch (err) {
          if (err instanceof Halt) { stop = stop || err; return; }
          failures++;
          r = { company: item.name, confidence: 'needs-review', status: 'queued', notes: `from ${item.sources.join('+')}`, reason: `error: ${String(err?.message || err).slice(0, 120)}` };
        }
        r.validation = validation;
        rows.push(r);
        appendFileSync(out, tsvRow(r) + '\n');
        status[r.status === 'accepted' ? 'accepted' : 'queued']++;
        const secs = (Date.now() - t0) / 1000;
        status.done++; status.seconds_per_company.push(Math.round(secs * 10) / 10);
        pg.log(`[${status.done}/${total}] ${item.name} ${r.status} ${r.domain || '-'} ${r.ats || '-'} ${secs.toFixed(0)}s${r.status === 'queued' ? '  (' + String(r.reason).slice(0, 90) + ')' : ''}`);
        pg.tick(r.status);
        if (status.seconds_per_company.length === 10 && !status.first10) {
          status.first10 = timingReport(status.seconds_per_company, (total - done.size) / WORKERS);
          console.log(`First 10: ${status.first10.avg_seconds}s per company each, ${WORKERS} at a time; about ${status.first10.estimated_total_minutes} min for all ${total - done.size}.`);
        }
        if (llm) status.llm_usage = llm.usage;
        writeStatus(status);
        const fb = failureBackoff({ failures, cooldowns });
        if (fb.action === 'halt') stop = stop || new Halt(3, `companies kept failing to load after ${cooldowns} pauses (last: ${item.name})`);
        else if (fb.action === 'pause' && Date.now() >= pausedUntil) {
          cooldowns++; failures = 0; pausedUntil = Date.now() + fb.minutes * 60000;
          pg.log(`[run] ${5} companies in a row could not be loaded: pausing ${fb.minutes} min (pause ${cooldowns} of 4), then carrying on`);
        }
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, worker));
    if (stop) throw stop;
    status.state = 'finished';
  } catch (err) {
    if (!(err instanceof Halt)) throw err;
    status.state = 'halted'; status.halt_reason = err.message; code = err.code;
    console.error(redact(`HALTED: ${err.message}. ${status.done} of ${total} done; rerun to resume.`));
  } finally {
    pg.done('', status.state === 'halted' ? 'halted' : 'finished');
    status.current = null;
    if (llm) { status.llm_usage = llm.usage; console.log(`LLM usage: ${llm.usage.calls} calls, ${llm.usage.input} input tokens, ${llm.usage.output} output tokens, ${llm.usage.errors} errors`); }
    writeStatus(status);
    await context.close().catch(() => {});
  }
  console.log(`Accepted ${status.accepted}, queued ${status.queued}.`);
  if (golden && code === 0) {
    const fails = checkGolden(golden, rows);
    console.log('\nGOLDEN REPORT (case | result | status | domain | layer that stopped it)');
    for (const c of golden) {
      const r = rows.find((x) => x.company === c.company) || {};
      const bad = fails.some((f) => f.startsWith(`${c.company}:`));
      const layer = r.status === 'accepted' ? '-' : String(r.reason || '').split(' || ')[0].split(' / ').map((x) => x.split(':')[0]).join(',');
      console.log(`${c.company} | ${bad ? 'FAIL' : 'pass'} | ${r.status} | ${r.domain || '-'} | ${layer}`);
    }
    if (fails.length) { console.error(`GOLDEN FAILED:\n  ${fails.join('\n  ')}`); return 5; }
    const verdict = goldenVerdict(golden, fails);
    if (!verdict.passed) { console.error(`GOLDEN NOT COUNTED: only ${verdict.confirmed} cases have confirmed domains and an expectation (need ${MIN_CONFIRMED}). No pass marker written.`); return 5; }
    writeFileSync(GOLDEN_PASS, JSON.stringify({ passed_at: new Date().toISOString(), cases: golden.length, confirmed: verdict.confirmed, llm: Boolean(llm), accepted: status.accepted }, null, 1) + '\n');
    console.log(`GOLDEN PASSED: ${verdict.confirmed} confirmed cases of ${golden.length}.`);
  }
  return code;
}

if (isMainModule(import.meta.url)) {
  main().then((c) => process.exit(c)).catch((err) => { console.error(redact(err?.stack || err)); process.exit(1); });
}
/** The pass marker needs enough confirmed cases; an all-unknown file can never pass. */
function goldenVerdict(cases, fails) {
  const confirmed = cases.filter((c) => c.expect !== 'unknown' && c.domains.length).length;
  return { confirmed, passed: fails.length === 0 && confirmed >= MIN_CONFIRMED, enough: confirmed >= MIN_CONFIRMED };
}
export { checkGolden, readGolden, goldenVerdict, tsvRow, COLUMNS, visit, searchResults, hostOf, Halt, gov, sleep };
export const setSessionContext = (c) => { sessionContext = c; };
