#!/usr/bin/env node

/**
 * scan-freehire.mjs: India entry-level scanner backed by the public freehire.me API.
 *
 * freehire aggregates ATS boards, Telegram hiring channels, Naukri, Wellfound,
 * Instahyre and more behind one keyless search endpoint. This scanner asks it
 * for postings first seen in the last N days that fit a fresher profile:
 *
 *   1. internships        employment_type=internship
 *   2. intern seniority   seniority=intern
 *   3. entry-level FTE    seniority=junior with 0 years required (or unstated)
 *   4. batch-year text    q="2027 batch" style free text (tech categories)
 *
 * Every query is limited to countries=IN and to software-leaning categories.
 * A client-side pass then drops postings that name a graduation batch other
 * than 2027, and applies the title allow/block lists below. What survives goes
 * through the same admission gate as scan-hn (seen set, blacklist) and is
 * appended to data/pipeline.md.
 *
 * Config: an optional `freehire:` block in portals.yml may override
 * `target_year`, `days`, `max_pages`, `categories`, `positive` and `negative`.
 * Zero LLM tokens.
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { loadYaml } from './lib/yaml-document.mjs';
import { appendToPipeline, appendToScanHistory, PORTALS_PATH, DATA_ROOT } from './scan.mjs';
import { join } from 'path';
import { buildTitleFilter } from './title-keywords.mjs';
import { requirePipelineConfig } from './lib/pipeline-config.mjs';
import { batchYears, yearOk } from './lib/batch-year.mjs';
import { seniorityVerdict } from './lib/seniority.mjs';
import { addFlag } from './lib/offer-flags.mjs';
import { scamFlags } from './lib/scam-flags.mjs';
import { jsonPathArg, writeStats } from './lib/json-out.mjs';
import { createRejectedLog } from './lib/rejected-log.mjs';
import { createAdmissionGate, formatSkipCounts } from './lib/admission-gate.mjs';
import { localToday } from './lib/local-today.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { printScanSummaryHeader } from './lib/scan-summary-marker.mjs';
import { validateFlags, flagValue, hasFlag } from './lib/cli-flags.mjs';
import { progress, fail } from './lib/progress.mjs';

const API = 'https://freehire.me/api/v1/jobs/search';
const PAGE = 100;

const KNOWN_FLAGS = ['--help', '-h', '--days', '--dry-run', '--max-pages', '--year', '--json'];
const USAGE = `Usage:
  node scan-freehire.mjs                 # last 2 days, India, entry level
  node scan-freehire.mjs --days 7        # first scan or catching up
  node scan-freehire.mjs --dry-run       # print matches, write nothing
  node scan-freehire.mjs --year 2027     # graduation batch to keep (default: batch_years in config/pipeline.yml)
  node scan-freehire.mjs --max-pages 3   # pages of 100 per query (default 3)

Queries the public freehire.me search API (no key) for India internships and
entry-level roles first seen in the last N days, keeps software-leaning titles
whose text names no batch year other than the target year, and appends the new
ones to data/pipeline.md. Optional overrides live under "freehire:" in portals.yml.

Flags:
  --days N, --year YYYY, --max-pages N, --dry-run, --json PATH (also write offers as JSON), --help, -h`;

// Software-leaning freehire categories. Anything outside is ignored server side.
const DEFAULT_CATEGORIES = [
  'software_engineering', 'backend', 'frontend', 'fullstack', 'mobile', 'devops', 'sre',
  'data_engineering', 'data_science', 'ml_ai', 'ai_engineering', 'security', 'embedded', 'qa',
];

// The title rules live in config/pipeline.yml, shared by every scanner.
const PIPELINE = requirePipelineConfig();
export const DEFAULT_POSITIVE = PIPELINE.title_filter.positive;
export const DEFAULT_NEGATIVE = PIPELINE.title_filter.negative;

// ── Config ──────────────────────────────────────────────────────────────

function loadOverrides() {
  if (!existsSync(PORTALS_PATH)) return {};
  try {
    return (loadYaml(readFileSync(PORTALS_PATH, 'utf-8')) || {}).freehire || {};
  } catch {
    return {};
  }
}

const list = (v, fallback) => (Array.isArray(v) && v.length ? v.map(String) : fallback);

// ── Queries ─────────────────────────────────────────────────────────────

/**
 * The four query shapes as URLSearchParams entries. `category` repeats, which
 * the API reads as OR. Kept pure so the tests can assert the URLs.
 */
export function buildQueries({ days, categories, year }) {
  const base = () => {
    const p = new URLSearchParams();
    p.set('countries', 'IN');
    p.set('open_within_days', String(days));
    p.set('sort', 'posted_at');
    p.set('limit', String(PAGE));
    for (const c of categories) p.append('category', c);
    return p;
  };
  const q = [];

  let p = base();
  p.set('employment_type', 'internship');
  q.push({ name: 'internship', params: p });

  p = base();
  p.set('seniority', 'intern');
  q.push({ name: 'intern-level', params: p });

  // Entry-level full time: junior, requiring 0 years or stating nothing.
  p = base();
  p.set('seniority', 'junior');
  p.set('employment_type', 'full_time');
  p.set('experience_years_max', '0');
  p.set('experience_include_unspecified', 'true');
  q.push({ name: 'junior-0yoe', params: p });

  // A batch-year phrase is rare and specific, so postings that state no
  // experience at all are kept. Generic fresher phrases match too widely
  // ("new grad" pulled in Staff and VP roles), so they must state 0 years.
  for (const phrase of [`${year} batch`, `${year} graduates`, `${year} passout`]) {
    p = base();
    p.set('q', phrase);
    p.set('experience_years_max', '1');
    p.set('experience_include_unspecified', 'true');
    q.push({ name: `text:${phrase}`, params: p });
  }
  for (const phrase of ['fresher', 'graduate engineer trainee', 'associate software engineer', 'software engineer I']) {
    p = base();
    p.set('q', phrase);
    p.set('experience_years_max', '0');
    q.push({ name: `text:${phrase}`, params: p });
  }
  return q;
}

export { batchYears, yearOk };

// ── Fetch ───────────────────────────────────────────────────────────────

const RATE_HEADERS = ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'ratelimit-remaining'];

/** What freehire said about its limits, e.g. "x-ratelimit-remaining=41". Empty when it sent none. */
export function rateLimitNote(headers) {
  return RATE_HEADERS.map((h) => [h, headers.get(h)]).filter(([, v]) => v != null).map(([h, v]) => `${h}=${v}`).join(' ');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET with the status and rate-limit headers logged. Retries (config freehire.retries, default 1) on 429, 5xx and network errors. */
export async function fetchJson(url, attempt = 0, cfg = PIPELINE.freehire || {}) {
  const retries = cfg.retries ?? 1;
  const backoff = (cfg.backoff_seconds ?? 4) * 1000;
  let res;
  try {
    res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'career-ops-scan-freehire' }, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    console.warn(`  freehire network error: ${err.message}`);
    if (attempt >= retries) throw new Error(`freehire unreachable: ${err.message}`);
    await sleep(backoff * 2 ** attempt);
    return fetchJson(url, attempt + 1, cfg);
  }
  const note = rateLimitNote(res.headers);
  if (!res.ok || note) console.log(`  freehire ${res.status}${note ? ` ${note}` : ''}`);
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= retries) throw new Error(`freehire ${res.status} after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}`);
    const asked = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(asked) && asked > 0 ? Math.min(asked, cfg.max_retry_after_seconds ?? 30) * 1000 : backoff * 2 ** attempt;
    await sleep(wait);
    return fetchJson(url, attempt + 1, cfg);
  }
  if (!res.ok) throw new Error(`freehire ${res.status} for ${url}`);
  return res.json();
}

async function runQuery({ name, params }, maxPages) {
  const rows = [];
  let ignored = [];
  for (let page = 0; page < maxPages; page++) {
    params.set('offset', String(page * PAGE));
    const body = await fetchJson(`${API}?${params}`);
    ignored = body.meta?.ignored_params || [];
    const data = body.data || [];
    rows.push(...data);
    if (data.length < PAGE || (page + 1) * PAGE >= (body.meta?.total ?? 0)) break;
  }
  return { name, rows, ignored: ignored.map((i) => i.param) };
}

// ── Mapping ─────────────────────────────────────────────────────────────

/** Remove tracking params so the same posting dedups against other scanners. */
export function cleanUrl(raw) {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) if (k.startsWith('utm_')) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return raw;
  }
}

export function toOffer(job) {
  const companyName = typeof job.company === 'object' ? job.company?.name : job.company;
  const cities = Array.isArray(job.cities) && job.cities.length ? job.cities.slice(0, 3).join(', ') : '';
  return {
    url: cleanUrl(job.url),
    title: String(job.title || '').trim(),
    company: String(companyName || '').trim(),
    location: cities || 'India',
    postedAt: job.posted_at ? String(job.posted_at).slice(0, 10) : undefined,
    source: `freehire:${job.source || 'unknown'}`,
  };
}

// ── Main ────────────────────────────────────────────────────────────────

async function main(args) {
  const o = loadOverrides();
  const days = Number(flagValue(args, '--days') ?? o.days ?? 2);
  const years = flagValue(args, '--year') ? [String(flagValue(args, '--year'))] : PIPELINE.batch_years.map(String);
  const year = years.join(' or ');
  const maxPages = Number(flagValue(args, '--max-pages') ?? o.max_pages ?? 3);
  const dryRun = hasFlag(args, '--dry-run');
  if (![days, maxPages].every((n) => Number.isInteger(n) && n > 0)) {
    console.error('Error: --days and --max-pages must be positive integers.');
    process.exit(1);
  }

  const categories = list(o.categories, DEFAULT_CATEGORIES);
  const gate = createAdmissionGate({
    titleFilter: buildTitleFilter(PIPELINE.title_filter),
    // The API already limited the country; city names alone would fail the
    // portals.yml location list for remote or multi-city rows.
    locationFilter: () => true,
  });

  console.log(`Fetching freehire: India, first seen in last ${days}d, batch ${year} or unstated...`);
  const results = [];
  const queries = buildQueries({ days, categories, year });
  for (const [i, q] of queries.entries()) {
    progress(i, queries.length, q.name);
    try {
      results.push(await runQuery(q, maxPages));
    } catch (err) {
      fail(q.name, err.message);
      console.warn(`  query "${q.name}" failed: ${err.message}`);
      process.exitCode = 1;
    }
  }

  // One freehire job often matches several queries; collapse by public_slug.
  const bySlug = new Map();
  const perQuery = [];
  const ignoredParams = new Set();
  for (const r of results) {
    perQuery.push(`${r.name}=${r.rows.length}`);
    r.ignored.forEach((p) => ignoredParams.add(p));
    for (const j of r.rows) if (!bySlug.has(j.public_slug || j.url)) bySlug.set(j.public_slug || j.url, j);
  }

  let yearDropped = 0;
  const rejected = createRejectedLog(join(DATA_ROOT, 'data', 'rejected.tsv'), { days: PIPELINE.rejected_log_days ?? 30 });
  const offers = [];
  for (const job of bySlug.values()) {
    const offer = toOffer(job);
    if (!offer.url || !offer.title) continue;
    const text = `${job.title}\n${String(job.description || '').slice(0, 4000)}`;
    if (!yearOk(text, years)) { yearDropped++; rejected.add(offer, 'batch_year'); continue; }
    const reason = gate.check(offer);
    if (reason) { if (reason !== 'seen') rejected.add(offer, reason); continue; }
    const exp = seniorityVerdict(String(job.description || ''), PIPELINE.seniority_guard);
    if (exp.action === 'drop') { rejected.add(offer, `experience_${exp.years}y`); continue; }
    if (exp.action === 'flag') addFlag(offer, `asks ${exp.years}+ yrs`);
    for (const reason of scamFlags(offer, String(job.description || ''), PIPELINE.scam)) addFlag(offer, reason);
    offers.push(offer);
  }

  printScanSummaryHeader('Freehire Scan', localToday());
  console.log(`Queries:            ${perQuery.join(', ') || 'none ran'}`);
  console.log(`Unique postings:    ${bySlug.size}`);
  if (yearDropped) console.log(`Wrong batch year:   ${yearDropped}`);
  const skipped = formatSkipCounts(gate.counts);
  if (skipped) console.log(`Skipped:            ${skipped}`);
  console.log(`New offers:         ${offers.length}`);
  if (ignoredParams.size) {
    console.warn(`\nWarning: freehire ignored params [${[...ignoredParams].join(', ')}]. Results may be broader than intended.`);
  }

  for (const o2 of offers) console.log(`  + ${o2.company || '?'} | ${o2.title} | ${o2.location} | ${o2.source}`);
  const jsonOut = flagValue(args, '--json');
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(offers));
  const queriesFailed = queries.length - results.length;
  writeStats(jsonOut, { fetched: bySlug.size, kept: offers.length, errors: queriesFailed, queries: queries.length });
  if (results.length === 0 && queries.length > 0) {
    console.error('freehire answered none of its queries. It may be down; nothing was added. Other scanners are unaffected.');
    process.exitCode = 1;
  }
  if (dryRun) { console.log('\n--dry-run: nothing written.'); return; }
  rejected.flush();
  if (offers.length > 0) {
    await appendToPipeline(offers);
    await appendToScanHistory(offers, localToday(), 'added');
    console.log(`\n${offers.length} offers added to the pipeline.`);
  }
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  validateFlags(args, KNOWN_FLAGS, USAGE, {
    valueFlags: ['--days', '--max-pages', '--year', '--json'],
    requireOperand: true,
  });
  main(args).catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
}
