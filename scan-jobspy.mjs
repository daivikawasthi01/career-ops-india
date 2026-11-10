#!/usr/bin/env node

/**
 * scan-jobspy.mjs: Naukri (and optionally Indeed / LinkedIn guest search) via
 * JobSpy, the open-source speedyapply/JobSpy library.
 *
 * tools/jobspy_scan.py does the scraping inside tools/.venv-jobspy and prints
 * JSON Lines. This script keeps postings that ask for no experience (Naukri
 * states it as "0 Yrs" or "0-2 Yrs"), applies the title block list shared with
 * scan-freehire.mjs and the 2027-or-unstated batch rule, then runs the
 * admission gate and appends to data/pipeline.md. Zero LLM tokens.
 *
 * Naukri has no public API, so JobSpy reads its web search and the board can
 * rate-limit. Keep --results modest; one run a day is plenty.
 */

import { spawn } from 'child_process';
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { appendToPipeline, appendToScanHistory } from './scan.mjs';
import { buildTitleFilter } from './title-keywords.mjs';
import { createAdmissionGate, formatSkipCounts } from './lib/admission-gate.mjs';
import { localToday } from './lib/local-today.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { printScanSummaryHeader } from './lib/scan-summary-marker.mjs';
import { validateFlags, flagValue, hasFlag } from './lib/cli-flags.mjs';
import { yearOk, cleanUrl } from './scan-freehire.mjs';
import { requirePipelineConfig } from './lib/pipeline-config.mjs';
import { seniorityVerdict } from './lib/seniority.mjs';
import { addFlag } from './lib/offer-flags.mjs';
import { scamFlags } from './lib/scam-flags.mjs';
import { writeStats } from './lib/json-out.mjs';
import { createRejectedLog } from './lib/rejected-log.mjs';
import { DATA_ROOT } from './scan.mjs';

const PIPELINE = requirePipelineConfig();

const HERE = dirname(fileURLToPath(import.meta.url));
const PY = join(HERE, 'tools', '.venv-jobspy', 'bin', 'python');
const HELPER = join(HERE, 'tools', 'jobspy_scan.py');

const KNOWN_FLAGS = ['--help', '-h', '--days', '--results', '--sites', '--year', '--max-years', '--dry-run', '--json', '--slow'];
const USAGE = `Usage:
  node scan-jobspy.mjs                    # Naukri, last 2 days, 0 years required
  node scan-jobspy.mjs --days 7           # first scan or catching up
  node scan-jobspy.mjs --sites naukri,indeed
  node scan-jobspy.mjs --max-years 1      # accept "0-1 Yrs" style ranges up to this minimum
  node scan-jobspy.mjs --dry-run          # print matches, write nothing

One-time setup (Python 3.10 or newer):
  python3.13 -m venv tools/.venv-jobspy && tools/.venv-jobspy/bin/pip install python-jobspy

Flags:
  --days N, --results N (per search term, default 100), --sites a,b, --year YYYY (default: batch_years in config/pipeline.yml),
  --max-years N (default 0), --dry-run, --json PATH, --help, -h
  --slow  one small batch for the rate-limited sites (config jobspy.slow: sites, per_run searches per site, wide jitter, last
          day only). Keeps its own rotation, so repeated batches walk through every term. Run it hourly or let mine.py spread it.

Sites seen working: naukri (can time out), indeed (few India results), linkedin (guest search,
no account used). google returned nothing in testing.`;

// The search terms live in config/pipeline.yml (jobspy.terms). All of them stay available.
export const TERMS = PIPELINE.jobspy?.terms ?? [];

/** Minimum years from Naukri-style ranges: "0 Yrs" -> 0, "2-4 Yrs" -> 2, "Fresher" -> 0. null if unreadable. */
export function minYears(range) {
  const s = String(range ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/fresher|entry/.test(s)) return 0;
  const m = s.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

export function toOffer(row) {
  return {
    url: cleanUrl(row.job_url),
    title: String(row.title || '').trim(),
    company: String(row.company || '').trim(),
    location: String(row.location || '').replace(/,?\s*India$/i, '') || 'India',
    postedAt: row.date_posted ? String(row.date_posted).slice(0, 10) : undefined,
    source: `jobspy:${row.site || 'unknown'}`,
  };
}

function readRotation(path) {
  try { return Number(JSON.parse(readFileSync(path, 'utf-8')).offset) || 0; } catch { return 0; }
}

/** After a budget-limited run, start next time at the first term that was skipped. */
export function nextRotation(current, skipped, terms) {
  if (!skipped.length) return 0;
  const i = terms.indexOf(skipped[0][1]); // skipped is in plan order, so the first is the next one due
  return i >= 0 ? i : current;
}

function saveRotation(path, current, skipped, terms) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ offset: nextRotation(current, skipped, terms) }));
  } catch { /* rotation is a convenience */ }
}

function runHelper(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(PY, [HELPER], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`jobspy helper exited ${code}`));
      const rows = [];
      let errors = {};
      let meta = {};
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        const obj = JSON.parse(line);
        if (obj._errors) errors = obj._errors; else if (obj._terms) meta = obj; else rows.push(obj);
      }
      resolve({ rows, errors, meta });
    });
    child.stdin.end(JSON.stringify(request));
  });
}

/** The slow lane's settings: which sites, how many searches per site per batch, how long to pause between calls. */
export function slowLane(cfg = {}) {
  const sites = Array.isArray(cfg.sites) && cfg.sites.length ? cfg.sites : ['linkedin', 'glassdoor'];
  const perRun = Number.isInteger(cfg.per_run) && cfg.per_run > 0 ? cfg.per_run : 3;
  const pause = Array.isArray(cfg.jitter_seconds) && cfg.jitter_seconds.length === 2 ? cfg.jitter_seconds : [20, 45];
  return {
    sites, days: Number.isInteger(cfg.days) && cfg.days > 0 ? cfg.days : 1,
    budget: Object.fromEntries(sites.map((x) => [x, perRun])), jitter: Object.fromEntries(sites.map((x) => [x, pause])),
  };
}

async function main(args) {
  const slow = hasFlag(args, '--slow');
  const lane = slow ? slowLane(PIPELINE.jobspy?.slow) : null;
  const days = lane ? lane.days : Number(flagValue(args, '--days') ?? 2);
  const results = Number(flagValue(args, '--results') ?? 100);
  const maxYears = Number(flagValue(args, '--max-years') ?? PIPELINE.max_min_experience_years ?? 0);
  const years = flagValue(args, '--year') ? [String(flagValue(args, '--year'))] : PIPELINE.batch_years.map(String);
  const sites = lane ? lane.sites : String(flagValue(args, '--sites') ?? 'naukri').split(',').map((s) => s.trim()).filter(Boolean);
  const dryRun = hasFlag(args, '--dry-run');
  if (![days, results].every((n) => Number.isInteger(n) && n > 0) || !Number.isInteger(maxYears) || maxYears < 0) {
    console.error('Error: --days and --results must be positive integers and --max-years a non-negative integer.');
    process.exit(1);
  }
  if (!existsSync(PY)) {
    console.error(`JobSpy venv missing at ${PY}.\n${USAGE}`);
    process.exit(1);
  }

  console.log(`Fetching ${sites.join(', ')} via JobSpy: ${TERMS.length} searches, last ${days}d...`);
  // Coverage and reliability over speed: every term runs on every site, and failed calls
  // retry with long backoff (see tools/jobspy_scan.py).
  const rotationPath = join(DATA_ROOT, 'data', 'cache', slow ? 'jobspy-slow-rotation.json' : 'jobspy-rotation.json');
  const rotate = readRotation(rotationPath);
  const { rows, errors, meta } = await runHelper({
    sites, terms: TERMS, rotate,
    budget: lane ? lane.budget : PIPELINE.jobspy?.request_budget, jitter: lane ? lane.jitter : PIPELINE.jobspy?.jitter_seconds, location: 'India', hours_old: days * 24, results_wanted: results,
    call_timeout: 60, retries: 2, backoff: [10, 30], breaker: 3, final_pass_wait: 90,
  });

  const gate = createAdmissionGate({
    titleFilter: buildTitleFilter(PIPELINE.title_filter),
    locationFilter: () => true,
  });
  const rejected = createRejectedLog(join(DATA_ROOT, 'data', 'rejected.tsv'), { days: PIPELINE.rejected_log_days ?? 30 });
  let overExperience = 0;
  let unreadableExperience = 0;
  let yearDropped = 0;
  const offers = [];
  for (const row of rows) {
    const min = minYears(row.experience_range);
    if (min === null) unreadableExperience++;
    // Unreadable experience is kept: a wrong drop costs a real job, a wrong keep costs one glance.
    if (min !== null && min > maxYears) { overExperience++; rejected.add(toOffer(row), `naukri_min_${min}y`); continue; }
    if (!yearOk(`${row.title}\n${String(row.description || '').slice(0, 4000)}`, years)) { yearDropped++; rejected.add(toOffer(row), 'batch_year'); continue; }
    const offer = toOffer(row);
    if (!offer.url || !offer.title) continue;
    const reason = gate.check(offer);
    if (reason) { if (reason !== 'seen') rejected.add(offer, reason); continue; }
    const exp = seniorityVerdict(String(row.description || ''), PIPELINE.seniority_guard);
    if (exp.action === 'drop') { rejected.add(offer, `experience_${exp.years}y`); continue; }
    if (exp.action === 'flag') addFlag(offer, `asks ${exp.years}+ yrs`);
    for (const why of scamFlags(offer, String(row.description || ''), PIPELINE.scam)) addFlag(offer, why);
    offer.term = row.term;
    offers.push(offer);
  }

  printScanSummaryHeader('JobSpy Scan', localToday());
  console.log(`Postings fetched:   ${rows.length}`);
  console.log(`Needs experience:   ${overExperience} dropped (minimum above ${maxYears} yr)`);
  if (unreadableExperience) console.log(`No experience info: ${unreadableExperience} kept`);
  if (yearDropped) console.log(`Wrong batch year:   ${yearDropped}`);
  const skipped = formatSkipCounts(gate.counts);
  if (skipped) console.log(`Skipped:            ${skipped}`);
  console.log(`New offers:         ${offers.length}`);
  if (Object.keys(errors).length) {
    console.warn(`\nWarning: JobSpy reported errors: ${JSON.stringify(errors)}`);
    if (rows.length === 0) process.exitCode = 1;
  }
  for (const o of offers) console.log(`  + ${o.company || '?'} | ${o.title} | ${o.location} | ${o.source}`);
  const jsonOut = flagValue(args, '--json');
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(offers));
  const skipped2 = meta?._budget_skipped || [];
  if (skipped2.length) console.log(`Request budget:     ${skipped2.length} search(es) left for the next run (rotation keeps them first in line)`);
  writeStats(jsonOut, { fetched: rows.length, kept: offers.length, errors: Object.keys(errors).length, terms: meta?._terms || {}, budgetSkipped: skipped2, spent: meta?._spent || {} });
  if (!dryRun) saveRotation(rotationPath, rotate, skipped2, TERMS);

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
    valueFlags: ['--days', '--results', '--sites', '--year', '--max-years', '--json'],
    requireOperand: true,
  });
  main(args).catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
}
