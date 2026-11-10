#!/usr/bin/env node
/**
 * watch-campus.mjs: change detection for campus / fresher programme pages (the campus_url column of
 * careers-discovery.tsv, plus a hand-kept watchlist). Fetches each page, hashes its visible text, and reports
 * what changed since the last run, flagging hiring-season signals ("applications open", "2027 batch", ...).
 *
 *   node tools/watch-campus.mjs                 check every page (state in data/campus-watch.json)
 *   node tools/watch-campus.mjs --limit 20      first 20 pages only
 *   node tools/watch-campus.mjs --list          print the pages that would be watched, fetch nothing
 *   node tools/watch-campus.mjs --workers 6
 *
 * Inputs:  data/campus-watchlist.txt   one URL per line (# comments), your own programme pages
 *          data/careers-discovery.tsv  campus_url column, kept only when it looks like a campus/early-career page
 * Outputs: data/campus-watch.json      per-URL state: hash, last text sample, last_ok, fail streak
 *          data/campus-watch-changes.tsv  append-only: date, url, kind (new|changed|signal|dead), signals, detail
 *
 * A page is only reported as changed when its text really changed: dates, counters and nav chrome are stripped
 * before hashing, so a rotating footer does not fire. A page that fails is retried on the next run and is only
 * called dead after 3 failures in a row. Read-only on the pages, polite (one request per host at a time).
 */
import { readFileSync, existsSync, writeFileSync, appendFileSync, renameSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const JOBAPPLY = resolve(HERE, '..', '..');
const ROOT = process.env.CAREER_OPS_ROOT || join(JOBAPPLY, 'career-ops');
const DATA = join(ROOT, 'data');

export const CAMPUS_URL_RE = /(campus|early[-_ ]?career|fresher|graduate|grad[-_]|intern|university|student|trainee|apprentic|talent[-_]?program|nqt|genc|techbee|elite|wilp|step)/i;
export const NOISE_URL_RE = /student-discount|credit-card|\/login|\/signin|press-?releases?|\bmou\b|campus-tours?|ambassador|\/category\/|predictor|\/customer|\/solutions\/|\/templates\/|\/(blog|news|press|stories|story|customer-stories|templates|articles?|20\d\d\/\d\d)\/|\/jobs\/[^/]+-[^/]+\/?$/i;
export const SIGNAL_RES = [
  ['applications-open', /\b(applications?|registrations?)\s+(are\s+)?(now\s+)?open\b|\bnow\s+(open|accepting)\b|\bregister\s+now\b|\bapply\s+now\b/i],
  ['batch-2027', /\b(batch\s+of\s+|class\s+of\s+|graduating\s+in\s+|passing\s+out\s+(in\s+)?)?20(27|28)\s*(batch|graduates?|passouts?|cohort)?\b/i],
  ['deadline', /\b(last\s+date|deadline|closes?\s+on|apply\s+by)\b/i],
  ['closed', /\b(applications?|registrations?)\s+(are\s+)?(now\s+)?closed\b|\bno\s+openings?\b/i],
];

/** Visible text of an HTML page, with volatile noise removed so the hash only moves on real changes. */
export function visibleText(html) {
  let t = String(html ?? '')
    .replace(/<(script|style|noscript|svg|template|nav|footer|header)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ');
  t = t.replace(/\b\d{1,2}[:.]\d{2}(:\d{2})?\s*(am|pm)?\b/gi, ' ') // clock times
    .replace(/\b(19|20)\d{2}-\d{2}-\d{2}(T[\d:.]+Z?)?\b/g, ' ') // ISO timestamps
    .replace(/\b\d+\s+(views?|visitors?|applicants?|registered|users?)\b/gi, ' ') // counters
    .replace(/©\s*\d{4}/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

export const hashText = (t) => createHash('sha256').update(t).digest('hex').slice(0, 16);

/** Unique lowercase words of 4+ letters (digits and short words dropped): a page's stable vocabulary. */
export function wordSet(text) { return [...new Set(String(text).toLowerCase().match(/\b[a-z]{4,}\b/g) || [])].sort().slice(0, 3000); }
export function jaccard(a, b) {
  if (!a.length && !b.length) return 1;
  const A = new Set(a); let inter = 0; for (const w of b) if (A.has(w)) inter++;
  return inter / (A.size + new Set(b).size - inter);
}
export const CHANGE_SIMILARITY = 0.9; // below this word overlap a page counts as really changed; listings and counters rotate more slowly than that

export function findSignals(text) {
  return SIGNAL_RES.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/** Pure decision: given the old state entry (or undefined) and a fetch result, what to record and report. */
export function diffState(old, res, today) {
  if (!res.ok) {
    const fails = (old?.fails || 0) + 1;
    return { next: { ...(old || {}), fails, last_error: res.error, last_try: today }, event: fails === 3 ? { kind: 'dead', detail: res.error } : null };
  }
  const hash = hashText(res.text);
  const signals = findSignals(res.text);
  const words = wordSet(res.text);
  const next = { hash, words, signals, fails: 0, last_ok: today, last_try: today, sample: res.text.slice(0, 600) };
  if (!old || !old.hash) return { next, event: { kind: 'new', signals, detail: `baseline, ${res.text.length} chars` } };
  if (old.hash === hash) return { next, event: null };
  const gained = signals.filter((s) => !(old.signals || []).includes(s));
  if (!old.words) return { next, event: gained.length ? { kind: 'signal', signals: gained, detail: 'signal appeared' } : null }; // first run after the upgrade: store the vocabulary, report nothing
  const sim = jaccard(old.words, words);
  if (gained.length) return { next, event: { kind: 'signal', signals: gained, detail: `${res.text.length} chars, word overlap ${sim.toFixed(2)}` } };
  if (sim >= CHANGE_SIMILARITY) return { next, event: null }; // same page, rotating bits
  return { next, event: { kind: 'changed', signals, detail: `${res.text.length} chars, word overlap ${sim.toFixed(2)}` } };
}

function readLines(f) { return existsSync(f) ? readFileSync(f, 'utf8').split('\n') : []; }

export function collectUrls(dataDir) {
  const urls = new Map(); // url -> source label
  for (const l of readLines(join(dataDir, 'campus-watchlist.txt'))) {
    const u = l.trim(); if (u && !u.startsWith('#') && /^https:\/\//.test(u)) urls.set(u, 'watchlist');
  }
  for (const l of readLines(join(dataDir, 'careers-discovery.tsv')).slice(1)) {
    const c = l.split('\t'); const u = (c[4] || '').trim();
    if (/^https:\/\//.test(u) && CAMPUS_URL_RE.test(new URL(u).pathname + ' ' + new URL(u).hostname) && !NOISE_URL_RE.test(new URL(u).pathname) && !urls.has(u)) urls.set(u, `discovery:${c[0]}`);
  }
  return urls;
}

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BOT_UA = 'Mozilla/5.0 (compatible; career-ops campus-watch)';

/** Plain HTTP read. Returns {ok, text} or {ok:false, error, needsBrowser} when only a real browser can read the page. */
async function fetchPage(url, ua = BOT_UA) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000), headers: { 'user-agent': ua, accept: 'text/html,*/*' } });
      if (r.status === 404 || r.status === 410) return { ok: false, error: `HTTP ${r.status}` };
      if (r.status === 403 && ua === BOT_UA) return fetchPage(url, BROWSER_UA); // one retry as a normal browser
      if (r.status === 403 || (r.status >= 300 && r.status < 400)) return { ok: false, error: `HTTP ${r.status}`, needsBrowser: true };
      if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 1500 * (attempt + 1))); if (attempt === 1) return { ok: false, error: `HTTP ${r.status}` }; continue; }
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      const text = visibleText((await r.text()).slice(0, 3_000_000));
      if (text.length < 200) return { ok: false, error: 'page has no readable text (JS-rendered?)', needsBrowser: true };
      return { ok: true, text };
    } catch (e) {
      const code = String(e?.cause?.code || '');
      if (/CERT|SELF_SIGNED|ERR_TLS/.test(code)) return { ok: false, error: code }; // a certificate fault is the site's, not ours: counted toward "dead"
      if (attempt === 1) return { ok: false, error: String(code || e?.message || e).slice(0, 80) };
    }
  }
  return { ok: false, error: 'unknown' };
}

/** Read pages that need a real browser, one shared headless Chromium, sequentially. Calls onResult(url, result). */
export async function readWithBrowser(urls, onResult, launch) {
  if (!urls.length) return;
  let browser;
  try { browser = await (launch ? launch() : (await import('playwright')).chromium.launch({ headless: true })); }
  catch (e) { for (const u of urls) onResult(u, { ok: false, error: `browser unavailable: ${String(e?.message || e).slice(0, 60)}` }); return; }
  try {
    for (const u of urls) {
      let result;
      for (let attempt = 0; attempt < 2 && !result?.ok; attempt++) { // a navigation can race a client-side redirect: one retry
        const page = await browser.newPage({ userAgent: BROWSER_UA });
        try {
          await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(3000);
          const text = visibleText(await page.evaluate(() => document.body?.innerText || ''));
          result = text.length >= 200 ? { ok: true, text } : { ok: false, error: 'browser read no text' };
        } catch (e) { result = { ok: false, error: `browser: ${String(e?.message || e).split('\n')[0].slice(0, 70)}` }; }
        finally { await page.close().catch(() => {}); }
      }
      onResult(u, result);
    }
  } finally { await browser.close().catch(() => {}); }
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const limit = Number(opt('--limit', 0)) || Infinity;
  const workers = Number(opt('--workers', 6));
  mkdirSync(DATA, { recursive: true });
  const stateFile = join(DATA, 'campus-watch.json');
  const changesFile = join(DATA, 'campus-watch-changes.tsv');
  let urls = [...collectUrls(DATA)].slice(0, limit);
  if (argv.includes('--only-failed')) { let st = {}; try { st = JSON.parse(readFileSync(join(DATA, 'campus-watch.json'), 'utf8')); } catch { /* none */ } urls = urls.filter(([u]) => st[u]?.fails); }
  if (argv.includes('--list')) { for (const [u, s] of urls) console.log(`${u}\t${s}`); console.log(`${urls.length} pages`); return; }
  if (!existsSync(changesFile)) writeFileSync(changesFile, 'date\turl\tkind\tsignals\tdetail\tsource\n');
  let state = {};
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* first run */ }
  const today = new Date().toISOString().slice(0, 10);
  if (!argv.includes('--only-failed') && !Number.isFinite(limit)) { const live = new Set(urls.map(([u]) => u)); for (const k of Object.keys(state)) if (!live.has(k)) delete state[k]; } // pages that left the list (or became noise) stop being tracked
  const browserQueue = [];
  const hostBusy = new Map(); let i = 0, newN = 0, changed = 0, failed = 0, ok = 0;
  const save = () => { writeFileSync(stateFile + '.tmp', JSON.stringify(state)); renameSync(stateFile + '.tmp', stateFile); };

  async function worker() {
    for (;;) {
      const entry = urls[i++]; if (!entry) return;
      const [url, source] = entry; const host = new URL(url).hostname;
      while (hostBusy.get(host)) await new Promise((r) => setTimeout(r, 200));
      hostBusy.set(host, true);
      let res; try { res = await fetchPage(url); } finally { setTimeout(() => hostBusy.delete(host), 500); }
      if (res.needsBrowser) { browserQueue.push([url, source]); continue; }
      record(url, source, res);
    }
  }
  function record(url, source, res) {
      const { next, event } = diffState(state[url], res, today);
      state[url] = next;
      res.ok ? ok++ : failed++;
      if (event) {
        if (event.kind === 'new') newN++; else if (event.kind !== 'dead') changed++;
        appendFileSync(changesFile, [today, url, event.kind, (event.signals || []).join(','), event.detail, source].map((v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t') + '\n');
        if (event.kind === 'signal' || event.kind === 'changed') console.log(`  ${event.kind.toUpperCase()} ${url} [${(event.signals || []).join(',')}]`);
      }
      if ((ok + failed) % 25 === 0) save();
  }
  await Promise.all(Array.from({ length: workers }, worker));
  const srcOf = new Map(urls);
  await readWithBrowser(browserQueue.map(([u]) => u), (u, res) => record(u, srcOf.get(u), res));
  save();
  console.log(`campus-watch: ${urls.length} pages, ${ok} read, ${failed} failed, ${newN} new baselines, ${changed} changed. See ${changesFile}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });
