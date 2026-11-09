#!/usr/bin/env node

/**
 * scan-all.mjs: one command for the whole India entry-level pipeline.
 *
 * Runs, in order, the scanners that find fresh fresher and intern roles:
 *   freehire     aggregator over ATS boards, Telegram, Naukri, Wellfound, Instahyre ...
 *   internshala  internships and fresher jobs (local open-source scraper)
 *   jobspy       Naukri, Indeed and LinkedIn guest search (no account)
 * Optional with --with-portals / --with-ats:
 *   portals      scan.mjs over the companies in portals.yml
 *   ats          scan-ats-full.mjs reverse sweep of public ATS directories
 *
 * Each scanner keeps its own filters and writes to data/pipeline.md (or not,
 * with --dry-run). This script then merges what they found, collapses the same
 * posting seen by several scanners, and prints a coverage table: for each
 * source you care about (LinkedIn, Naukri, Internshala, ATS platforms ...),
 * did it produce anything this run. A step that fails does not stop the others.
 */

import { spawn } from 'child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { isMainModule } from './lib/is-main-module.mjs';
import { validateFlags, flagValue, hasFlag } from './lib/cli-flags.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const KNOWN_FLAGS = ['--help', '-h', '--dry-run', '--days', '--only', '--skip', '--with-portals', '--with-ats', '--sites'];
const USAGE = `Usage:
  node scan-all.mjs                        # run freehire, internshala, jobspy; write the pipeline
  node scan-all.mjs --dry-run              # same, write nothing, still print the coverage table
  node scan-all.mjs --days 7               # look back further (first run)
  node scan-all.mjs --only freehire,jobspy # run a subset
  node scan-all.mjs --skip internshala
  node scan-all.mjs --sites naukri,indeed,linkedin   # JobSpy boards (default all three)
  node scan-all.mjs --with-portals --with-ats        # also scan.mjs and the reverse ATS sweep

Flags:
  --dry-run, --days N, --only a,b, --skip a,b, --sites a,b, --with-portals, --with-ats, --help, -h`;

// ── Coverage classification ─────────────────────────────────────────────

const HOSTS = [
  [/linkedin\.com/i, 'linkedin'], [/naukri\.com/i, 'naukri'], [/internshala\.com/i, 'internshala'],
  [/indeed\./i, 'indeed'], [/wellfound\.com|angel\.co/i, 'wellfound'], [/instahyre\.com/i, 'instahyre'],
  [/shine\.com/i, 'shine'], [/unstop\.com/i, 'unstop'], [/cutshort\.io/i, 'cutshort'],
  [/greenhouse\.io/i, 'greenhouse'], [/lever\.co/i, 'lever'], [/ashbyhq\.com/i, 'ashby'],
  [/myworkdayjobs\.com|workday/i, 'workday'], [/smartrecruiters\.com/i, 'smartrecruiters'],
  [/oraclecloud\.com/i, 'oracle'], [/zohorecruit\.|zoho\./i, 'zohorecruit'], [/keka\.com/i, 'keka'],
  [/workable\.com/i, 'workable'], [/icims\.com/i, 'icims'], [/himalayas\.app/i, 'himalayas'],
];
const ATS_NAMES = new Set(['greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'oracle', 'zohorecruit',
  'keka', 'workable', 'icims', 'phenom', 'eightfold', 'successfactors', 'teamtailor', 'recruitee', 'rippling',
  'taleobe', 'adpmyjobs', 'builtin', 'google', 'amazon']);

/** Which site a posting lives on: its URL host first, then the scanner's own source tag. */
export function siteOf(offer) {
  for (const [re, name] of HOSTS) if (re.test(offer.url || '')) return name;
  const tag = String(offer.source || '').split(':').pop().toLowerCase();
  return tag || 'unknown';
}

/** Where the scanner found it, for the "also seen via" column. */
export function channelOf(offer) {
  return String(offer.source || 'unknown').toLowerCase();
}

export function normUrl(url) {
  try {
    const u = new URL(url);
    // Indeed identifies a posting only by ?jk= (or vjk), so the query stays in the key.
    const jk = u.searchParams.get('jk') || u.searchParams.get('vjk');
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${jk ? `?jk=${jk}` : ''}`.toLowerCase();
  } catch {
    return String(url || '').toLowerCase();
  }
}

/** Collapse the same posting reported by more than one scanner. */
export function mergeOffers(perStep) {
  const byUrl = new Map();
  for (const [step, offers] of Object.entries(perStep)) {
    for (const o of offers) {
      const key = normUrl(o.url);
      const hit = byUrl.get(key);
      if (hit) hit.steps.add(step);
      else byUrl.set(key, { ...o, site: siteOf(o), steps: new Set([step]) });
    }
  }
  return [...byUrl.values()];
}

export const EXPECTED = [
  { label: 'LinkedIn', sites: ['linkedin'] },
  { label: 'Naukri', sites: ['naukri'] },
  { label: 'Internshala', sites: ['internshala'] },
  { label: 'Indeed', sites: ['indeed'] },
  { label: 'Wellfound', sites: ['wellfound'] },
  { label: 'Instahyre', sites: ['instahyre'] },
  { label: 'Telegram channels', sites: ['telegram'] },
  { label: 'ATS platforms', sites: [...ATS_NAMES] },
];

export function coverage(merged) {
  const tagOf = (o) => String(o.source || '').split(':').pop().toLowerCase();
  return EXPECTED.map(({ label, sites }) => {
    const hits = merged.filter((o) => sites.includes(o.site) || sites.includes(tagOf(o)));
    const per = new Map();
    for (const o of hits) {
      const k = sites.includes(o.site) ? o.site : tagOf(o);
      per.set(k, (per.get(k) || 0) + 1);
    }
    return { label, count: hits.length, detail: [...per].map(([k, v]) => `${k} ${v}`).join(', ') };
  });
}

// ── Steps ───────────────────────────────────────────────────────────────

function steps({ days, dryRun, sites, withPortals, withAts }) {
  const dry = dryRun ? ['--dry-run'] : [];
  const list = [
    { id: 'freehire', file: 'scan-freehire.mjs', args: ['--days', String(days)], json: true },
    { id: 'internshala', file: 'scan-internshala.mjs', args: ['--days', String(days + 1)], json: true },
    { id: 'jobspy', file: 'scan-jobspy.mjs', args: ['--days', String(days), '--sites', sites], json: true },
  ];
  if (withPortals) list.push({ id: 'portals', file: 'scan.mjs', args: ['--since', String(days), '--quiet'], json: false });
  if (withAts) list.push({ id: 'ats', file: 'scan-ats-full.mjs', args: ['--since', String(days), '--ats', 'greenhouse,lever,ashby', '--limit', '400'], json: false });
  return list.map((s) => ({ ...s, args: [...s.args, ...dry] }));
}

function run(step, jsonPath) {
  return new Promise((resolve) => {
    const started = Date.now();
    const args = [join(HERE, step.file), ...step.args, ...(step.json ? ['--json', jsonPath] : [])];
    const child = spawn(process.execPath, args, { cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err, secs: Math.round((Date.now() - started) / 1000) }));
    child.on('error', (e) => resolve({ code: 1, out, err: String(e), secs: 0 }));
  });
}

function pad(s, n) { return String(s).padEnd(n); }

async function main(args) {
  const days = Number(flagValue(args, '--days') ?? 2);
  const dryRun = hasFlag(args, '--dry-run');
  const only = (flagValue(args, '--only') || '').split(',').filter(Boolean);
  const skip = (flagValue(args, '--skip') || '').split(',').filter(Boolean);
  const sites = flagValue(args, '--sites') || 'naukri,indeed,linkedin';
  if (!Number.isInteger(days) || days < 1) { console.error('Error: --days must be a positive integer.'); process.exit(1); }

  const tmp = mkdtempSync(join(tmpdir(), 'scan-all-'));
  const plan = steps({ days, dryRun, sites, withPortals: hasFlag(args, '--with-portals'), withAts: hasFlag(args, '--with-ats') })
    .filter((s) => (only.length ? only.includes(s.id) : true) && !skip.includes(s.id));

  console.log(`scan-all: ${plan.map((s) => s.id).join(', ')} | last ${days}d${dryRun ? ' | DRY RUN' : ''}\n`);
  const perStep = {};
  const status = [];
  for (const step of plan) {
    const jsonPath = join(tmp, `${step.id}.json`);
    process.stdout.write(`> ${step.id} ... `);
    const r = await run(step, jsonPath);
    let offers = [];
    if (step.json && existsSync(jsonPath)) {
      try { offers = JSON.parse(readFileSync(jsonPath, 'utf-8')); } catch { /* reported below */ }
    }
    perStep[step.id] = offers;
    const ok = r.code === 0;
    const note = !ok ? (r.err.trim().split('\n').pop() || r.out.trim().split('\n').pop() || `exit ${r.code}`).slice(0, 110) : '';
    status.push({ id: step.id, ok, secs: r.secs, count: step.json ? offers.length : null, note, tail: step.json ? '' : r.out.trim().split('\n').filter((l) => /found|match|New offers|added/i.test(l)).slice(-3).join(' / ') });
    console.log(`${ok ? 'ok' : 'FAILED'} (${r.secs}s${step.json ? `, ${offers.length} new` : ''})`);
    if (!ok && note) console.log(`    ${note}`);
  }
  rmSync(tmp, { recursive: true, force: true });

  const merged = mergeOffers(perStep);
  const total = Object.values(perStep).reduce((n, a) => n + a.length, 0);

  console.log('\n=== Step results ===');
  for (const s of status) {
    console.log(`${pad(s.id, 12)} ${s.ok ? 'ok    ' : 'FAILED'} ${pad(s.count == null ? '-' : s.count, 5)} ${s.tail || s.note}`);
  }
  console.log(`\nNew postings: ${total} reported, ${merged.length} after merging duplicates across scanners`);

  console.log('\n=== Coverage: did each source come up? ===');
  for (const c of coverage(merged)) {
    console.log(`${c.count > 0 ? 'YES' : 'NO '}  ${pad(c.label, 18)} ${pad(c.count, 5)} ${c.detail}`);
  }

  const bySite = {};
  for (const o of merged) bySite[o.site] = (bySite[o.site] || 0) + 1;
  console.log('\nAll sites seen: ' + Object.entries(bySite).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
  if (dryRun) console.log('\nDry run: nothing was written. Run without --dry-run to add these to data/pipeline.md.');
  if (status.some((s) => !s.ok)) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: ['--days', '--only', '--skip', '--sites'], requireOperand: true });
  main(args).catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
}
