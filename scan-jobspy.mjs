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
import { existsSync, writeFileSync } from 'fs';
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
import { createRejectedLog } from './lib/rejected-log.mjs';
import { DATA_ROOT } from './scan.mjs';

const PIPELINE = requirePipelineConfig();

const HERE = dirname(fileURLToPath(import.meta.url));
const PY = join(HERE, 'tools', '.venv-jobspy', 'bin', 'python');
const HELPER = join(HERE, 'tools', 'jobspy_scan.py');

const KNOWN_FLAGS = ['--help', '-h', '--days', '--results', '--sites', '--year', '--max-years', '--dry-run', '--json'];
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

Sites seen working: naukri (can time out), indeed (few India results), linkedin (guest search,
no account used). google returned nothing in testing.`;

export const TERMS = [
  'software engineer fresher', 'software developer fresher', 'sde 1', 'associate software engineer',
  'graduate engineer trainee', 'backend developer fresher', 'full stack developer fresher',
  'python developer fresher', 'java developer fresher', 'data engineer fresher',
  'machine learning engineer fresher', 'software engineer intern',
  'frontend developer fresher', 'web developer fresher', 'devops engineer fresher', 'cloud engineer fresher',
  'junior software engineer', 'software engineer trainee', 'sde intern', 'ai engineer fresher',
];

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
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        const obj = JSON.parse(line);
        if (obj._errors) errors = obj._errors; else rows.push(obj);
      }
      resolve({ rows, errors });
    });
    child.stdin.end(JSON.stringify(request));
  });
}

async function main(args) {
  const days = Number(flagValue(args, '--days') ?? 2);
  const results = Number(flagValue(args, '--results') ?? 100);
  const maxYears = Number(flagValue(args, '--max-years') ?? PIPELINE.max_min_experience_years ?? 0);
  const years = flagValue(args, '--year') ? [String(flagValue(args, '--year'))] : PIPELINE.batch_years.map(String);
  const sites = String(flagValue(args, '--sites') ?? 'naukri').split(',').map((s) => s.trim()).filter(Boolean);
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
  const { rows, errors } = await runHelper({
    sites, terms: TERMS, location: 'India', hours_old: days * 24, results_wanted: results,
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
