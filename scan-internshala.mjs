#!/usr/bin/env node

/**
 * scan-internshala.mjs: Internshala internships and fresher jobs.
 *
 * Reads the open-source omkarcloud/internshala-scraper, a small local HTTP API
 * (no key, no login). By default this script starts it for the run and stops it
 * after, from ../internshala-scraper (override with INTERNSHALA_SCRAPER_DIR).
 * If something already answers on INTERNSHALA_API (default http://localhost:8000)
 * it is used as is and left running.
 *
 * Internshala's category filter takes one value per call, so each software
 * category is a separate query. Internships come from /internships/search and
 * fresher jobs from /jobs/search?experience=fresher. Postings older than
 * --days are dropped, the title block list from scan-freehire.mjs applies, and
 * what survives goes through the admission gate (seen set, blacklist) into
 * data/pipeline.md. Zero LLM tokens.
 */

import { spawn } from 'child_process';
import { existsSync, writeFileSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { appendToPipeline, appendToScanHistory, DATA_ROOT } from './scan.mjs';
import { buildTitleFilter } from './title-keywords.mjs';
import { createAdmissionGate, formatSkipCounts } from './lib/admission-gate.mjs';
import { localToday } from './lib/local-today.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { printScanSummaryHeader } from './lib/scan-summary-marker.mjs';
import { validateFlags, flagValue, hasFlag } from './lib/cli-flags.mjs';
import { progress, fail } from './lib/progress.mjs';
import { requirePipelineConfig } from './lib/pipeline-config.mjs';

import { createRejectedLog } from './lib/rejected-log.mjs';
import { scamFlags } from './lib/scam-flags.mjs';
import { addFlag } from './lib/offer-flags.mjs';
import { writeStats } from './lib/json-out.mjs';
import { isLoopback, portFree, onShutdown, gitHead } from './lib/local-service.mjs';

const PIPELINE = requirePipelineConfig();

const HERE = dirname(fileURLToPath(import.meta.url));
const API = (process.env.INTERNSHALA_API || 'http://localhost:8000').replace(/\/$/, '');
const SCRAPER_DIR = resolve(process.env.INTERNSHALA_SCRAPER_DIR || join(HERE, '..', 'internshala-scraper'));

const KNOWN_FLAGS = ['--help', '-h', '--days', '--max-pages', '--dry-run', '--no-serve', '--internships-only', '--jobs-only', '--include-unpaid', '--json'];
const USAGE = `Usage:
  node scan-internshala.mjs                    # last 3 days, internships + fresher jobs
  node scan-internshala.mjs --days 7           # first scan or catching up
  node scan-internshala.mjs --dry-run          # print matches, write nothing
  node scan-internshala.mjs --max-pages 3      # result pages per category (default 2)
  node scan-internshala.mjs --no-serve         # do not start the local API, expect it on ${API}
  node scan-internshala.mjs --internships-only | --jobs-only
  node scan-internshala.mjs --include-unpaid   # keep unpaid internships (kept and marked [unpaid] by default; set borderline.unpaid: drop in config/pipeline.yml)

Needs the scraper set up once: clone omkarcloud/internshala-scraper next to
career-ops, create its .venv and pip install -r requirements.txt.

Flags:
  --days N, --max-pages N, --dry-run, --no-serve, --internships-only, --jobs-only, --json PATH, --help, -h`;

// Internshala category labels, each checked against the live API.
export const CATEGORIES = [
  'Software Development', 'Web Development', 'Backend Development', 'Full Stack Development',
  'Computer Science', 'Data Science', 'Machine Learning', 'Artificial Intelligence (AI)',
  'Python/Django', 'Java Development', 'Node.js Development', 'Mobile App Development', 'Cloud Computing',
];

// ── Local API lifecycle ─────────────────────────────────────────────────

async function apiUp() {
  try {
    const res = await fetch(`${API}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

/** A real request, not just "something answers": one category page must come back as JSON with a list. */
export async function apiHealthy() {
  try {
    const res = await fetch(`${API}/internships/search?category=${encodeURIComponent('Software Development')}&page=1`, { signal: AbortSignal.timeout(45_000) });
    const body = await res.json();
    return res.ok && Array.isArray(body.internships);
  } catch {
    return false;
  }
}

/** The scraper clone must still be at the commit we reviewed (tools/internshala-pin.txt). */
function checkPin() {
  const pinFile = join(HERE, 'tools', 'internshala-pin.txt');
  if (!existsSync(pinFile) || process.env.INTERNSHALA_ALLOW_UNPINNED === '1') return;
  const want = readFileSync(pinFile, 'utf-8').trim();
  const have = gitHead(SCRAPER_DIR);
  if (have && want && have !== want) {
    throw new Error(`internshala-scraper is at ${have.slice(0, 10)} but ${want.slice(0, 10)} was reviewed. Review the change, update tools/internshala-pin.txt, or set INTERNSHALA_ALLOW_UNPINNED=1.`);
  }
}

async function startApi() {
  const py = join(SCRAPER_DIR, '.venv', 'bin', 'python');
  const wrapper = join(HERE, 'tools', 'internshala_serve.py');
  if (!existsSync(py) || !existsSync(join(SCRAPER_DIR, 'run.py'))) {
    throw new Error(`internshala-scraper not set up at ${SCRAPER_DIR} (need .venv and run.py). See --help.`);
  }
  if (!isLoopback(API)) throw new Error(`INTERNSHALA_API ${API} is not a local address; refusing to start a scraper for it.`);
  checkPin();
  const port = new URL(API).port || '8000';
  if (!(await portFree(Number(port)))) {
    throw new Error(`port ${port} is in use by something that does not answer as the scraper. Free it or set INTERNSHALA_API to another port.`);
  }
  // The wrapper listens on 127.0.0.1 only; upstream run.py listens on 0.0.0.0.
  const child = spawn(py, [wrapper], { cwd: SCRAPER_DIR, env: { ...process.env, PORT: port }, stdio: 'ignore' });
  for (let i = 0; i < 30; i++) {
    if (await apiUp()) return child;
    if (child.exitCode !== null) throw new Error(`internshala-scraper exited with ${child.exitCode} while starting`);
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error('internshala-scraper did not start within 15s');
}

async function getJson(path, params) {
  const url = `${API}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// ── Mapping ─────────────────────────────────────────────────────────────

/** Internship cards have a bare field name as title ("Data Engineering"); make the role explicit. */
export function internshipTitle(title) {
  const t = String(title || '').trim();
  return /intern/i.test(t) ? t : `${t} Intern`;
}

/** The posting day from "N days ago" when the card carries no date, so the freshness gate can check its age. */
export function postedFromDaysAgo(daysAgo, now = Date.now()) {
  return typeof daysAgo === 'number' && daysAgo >= 0 ? new Date(now - daysAgo * 864e5).toISOString().slice(0, 10) : undefined;
}

export function toOffer(card, kind) {
  const place = Array.isArray(card.locations) && card.locations.length ? card.locations.slice(0, 3).join(', ') : '';
  const where = card.work_mode === 'work_from_home' ? 'Remote (India)' : place || 'India';
  const stipend = card.stipend?.is_unpaid ? ' [unpaid]' : '';
  return {
    url: card.link,
    title: kind === 'internship' ? internshipTitle(card.title) : String(card.title || '').trim(),
    company: card.company?.name || '',
    location: where + stipend,
    postedAt: card.posted?.date || postedFromDaysAgo(card.posted?.days_ago),
    source: kind === 'internship' ? 'internshala:internship' : 'internshala:job',
  };
}

export function fresh(card, days) {
  const age = card.posted?.days_ago;
  return typeof age !== 'number' || age <= days;
}

// ── Main ────────────────────────────────────────────────────────────────

async function collect(kind, days, maxPages, log, includeUnpaid) {
  const path = kind === 'internship' ? '/internships/search' : '/jobs/search';
  const field = kind === 'internship' ? 'internships' : 'jobs';
  const out = [];
  for (const [ci, category] of CATEGORIES.entries()) {
    progress(ci, CATEGORIES.length, `${kind}:${category}`);
    for (let page = 1; page <= maxPages; page++) {
      const params = { category, page: String(page) };
      if (kind === 'job') params.experience = 'fresher';
      let body;
      try {
        body = await getJson(path, params);
      } catch (err) {
        fail(`${kind}:${category}`, err.message);
        log(`  ${kind} "${category}" p${page} failed: ${err.message}`);
        process.exitCode = 1;
        break;
      }
      const cards = body[field] || [];
      out.push(
        ...cards
          .filter((c) => fresh(c, days) && (includeUnpaid || !c.stipend?.is_unpaid))
          .map((c) => toOffer(c, kind)),
      );
      // Cards are newest first, so a page with nothing fresh ends this category.
      if (!cards.some((c) => fresh(c, days)) || !body.next) break;
    }
  }
  return out;
}

async function main(args) {
  const days = Number(flagValue(args, '--days') ?? 3);
  const maxPages = Number(flagValue(args, '--max-pages') ?? 2);
  const dryRun = hasFlag(args, '--dry-run');
  if (![days, maxPages].every((n) => Number.isInteger(n) && n > 0)) {
    console.error('Error: --days and --max-pages must be positive integers.');
    process.exit(1);
  }

  let child = null;
  if (!(await apiUp())) {
    if (hasFlag(args, '--no-serve')) throw new Error(`Nothing answering on ${API}`);
    console.log('Starting local internshala-scraper (127.0.0.1 only)...');
    child = await startApi();
  }
  // Stops the scraper on normal exit, Ctrl-C, SIGTERM and crashes.
  const stopHooks = onShutdown(() => { if (child && child.exitCode === null) child.kill(); });
  if (!(await apiHealthy())) {
    stopHooks();
    throw new Error('internshala-scraper answered but a test search failed; not scanning. Check it by hand.');
  }

  try {
    const warn = (m) => console.warn(m);
    const kinds = [];
    if (!hasFlag(args, '--jobs-only')) kinds.push('internship');
    if (!hasFlag(args, '--internships-only')) kinds.push('job');

    console.log(`Fetching Internshala (${kinds.join(' + ')}), last ${days}d...`);
    const found = [];
    const includeUnpaid = hasFlag(args, '--include-unpaid') || PIPELINE.borderline?.unpaid !== 'drop';
    for (const kind of kinds) found.push(...(await collect(kind, days, maxPages, warn, includeUnpaid)));

    const gate = createAdmissionGate({
      titleFilter: buildTitleFilter({ positive: [], negative: PIPELINE.title_filter.negative, protect: PIPELINE.title_filter.protect }),
      locationFilter: () => true,
    });
    const rejected = createRejectedLog(join(DATA_ROOT, 'data', 'rejected.tsv'), { days: PIPELINE.rejected_log_days ?? 30 });
    const seenHere = new Set();
    const offers = [];
    for (const offer of found) {
      if (!offer.url || seenHere.has(offer.url)) continue;
      seenHere.add(offer.url);
      const reason = gate.check(offer);
      if (reason) { if (reason !== 'seen') rejected.add(offer, reason); continue; }
      for (const why of scamFlags(offer, '', PIPELINE.scam)) addFlag(offer, why);
      offers.push(offer);
    }

    printScanSummaryHeader('Internshala Scan', localToday());
    console.log(`Fresh postings:     ${seenHere.size}`);
    const skipped = formatSkipCounts(gate.counts);
    if (skipped) console.log(`Skipped:            ${skipped}`);
    console.log(`New offers:         ${offers.length}`);
    for (const o of offers) console.log(`  + ${o.company || '?'} | ${o.title} | ${o.location} | ${o.source}`);
    const jsonOut = flagValue(args, '--json');
    if (jsonOut) writeFileSync(jsonOut, JSON.stringify(offers));
    writeStats(jsonOut, { fetched: seenHere.size, kept: offers.length, errors: process.exitCode ? 1 : 0 });

    if (dryRun) { console.log('\n--dry-run: nothing written.'); return; }
    rejected.flush();
    if (offers.length > 0) {
      await appendToPipeline(offers);
      await appendToScanHistory(offers, localToday(), 'added');
      console.log(`\n${offers.length} offers added to the pipeline.`);
    }
  } finally {
    stopHooks();
  }
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: ['--days', '--max-pages', '--json'], requireOperand: true });
  main(args).catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
}
