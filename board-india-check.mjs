#!/usr/bin/env node

/**
 * board-india-check.mjs: does a board have anything for an Indian fresher?
 *
 * "The board answered" is not the goal. For each selected portals.yml entry this fetches the
 * board once and counts, with the same title_filter and location_filter scan.mjs uses:
 *
 *   india   postings whose location passes location_filter
 *   entry   postings whose title passes title_filter
 *   both    postings passing both (what a scan would actually keep)
 *
 * A board with both = 0 scores zero. Fetch errors are reported and never counted as zero.
 *
 *   node board-india-check.mjs --source jobradar          # preview: table + report, writes no config
 *   node board-india-check.mjs --source jobradar --apply  # enable disabled jobradar boards with both > 0,
 *                                                         # disable enabled boards with both = 0
 *   node board-india-check.mjs --company Razorpay         # one board
 *   node board-india-check.mjs --disabled | --all        # other selections
 *   options: --limit N  --concurrency N (default 6)  --force (apply while discover-ats runs)
 *
 * Re-enabling is limited to boards tagged `source: jobradar`; boards you disabled yourself are
 * never switched back on. portals.yml is only written with --apply, after a backup.
 * The report goes to data/cache/board-india-check.tsv.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { loadYaml } from './lib/yaml-document.mjs';
import { loadProviders, resolveProvider } from './providers/_registry.mjs';
import { makeHttpCtx } from './providers/_http.mjs';
import { buildTitleFilter, buildLocationFilter } from './scan.mjs';
import { applyPipelineConfig } from './lib/pipeline-config.mjs';
import { discoverIsRunning, backupFile, atomicWrite, setEnabledInText } from './lib/portals-edit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || join(HERE, 'portals.yml');
const REPORT_PATH = join(HERE, 'data', 'cache', 'board-india-check.tsv');

/** Count postings that pass the location filter, the title filter, and both. Pure. */
export function scoreJobs(jobs, titleFilter, locationFilter) {
  let india = 0;
  let entry = 0;
  let both = 0;
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const inIndia = Boolean(locationFilter(job.location, job.url, job.title, job));
    const entryLevel = Boolean(titleFilter(job.title));
    if (inIndia) india++;
    if (entryLevel) entry++;
    if (inIndia && entryLevel) both++;
  }
  return { total: Array.isArray(jobs) ? jobs.length : 0, india, entry, both };
}

/** What --apply should do for one checked entry, or null for no change. Pure. */
export function decideChange(entry, result) {
  if (result.status !== 'ok') return null; // errors are never read as zero
  const enabled = entry.enabled !== false;
  if (result.both === 0 && enabled) return 'disable';
  if (result.both > 0 && !enabled && entry.source === 'jobradar') return 'enable';
  return null;
}

async function pool(items, limit, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) { const n = i++; await fn(items[n], n); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function parseArgs(argv) {
  const get = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  return {
    apply: argv.includes('--apply'),
    force: argv.includes('--force'),
    all: argv.includes('--all'),
    disabled: argv.includes('--disabled'),
    source: get('--source'),
    company: get('--company'),
    limit: Number(get('--limit')) || 0,
    concurrency: Number(get('--concurrency')) || 6,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!(opts.all || opts.disabled || opts.source || opts.company)) {
    console.error('Pick a selection: --source jobradar | --company NAME | --disabled | --all');
    process.exit(1);
  }
  if (!existsSync(PORTALS_PATH)) { console.error(`Error: ${PORTALS_PATH} not found.`); process.exit(1); }
  if (!process.env.CAREER_OPS_HTTP_TIMEOUT_MS) process.env.CAREER_OPS_HTTP_TIMEOUT_MS = '30000';

  const portalsText = readFileSync(PORTALS_PATH, 'utf-8');
  const config = applyPipelineConfig(loadYaml(portalsText) || {});
  const entries = (config.tracked_companies || []).filter((e) => e && typeof e.name === 'string');
  let selected = entries.filter((e) => {
    if (opts.company) return e.name.toLowerCase() === opts.company.toLowerCase();
    if (opts.source) return e.source === opts.source;
    if (opts.disabled) return e.enabled === false;
    return true;
  });
  if (opts.limit) selected = selected.slice(0, opts.limit);
  if (!selected.length) { console.log('No entries match that selection.'); return; }

  const providers = await loadProviders(resolve(HERE, 'providers'));
  const titleFilter = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);
  const ctx = makeHttpCtx();

  const results = new Array(selected.length);
  let done = 0;
  await pool(selected, opts.concurrency, async (entry, idx) => {
    const resolved = resolveProvider(entry, providers);
    let result;
    if (!resolved || resolved.error) {
      result = { status: 'no_provider', total: 0, india: 0, entry: 0, both: 0, note: resolved?.error || 'no provider matched' };
    } else {
      try {
        const jobs = await resolved.provider.fetch({ ...entry }, ctx);
        result = { status: 'ok', ...scoreJobs(jobs, titleFilter, locationFilter) };
      } catch (err) {
        result = { status: 'error', total: 0, india: 0, entry: 0, both: 0, note: String(err?.message || err).slice(0, 120) };
      }
    }
    results[idx] = result;
    done++;
    console.error(`[${done}/${selected.length}] ${entry.name} ${result.status === 'ok' ? `india ${result.india}, entry ${result.entry}, both ${result.both}` : result.status}`);
  });

  const today = new Date().toISOString().slice(0, 10);
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  const rows = selected.map((e, i) => [today, e.name, e.source || '', e.enabled === false ? 'disabled' : 'enabled',
    results[i].status, results[i].total, results[i].india, results[i].entry, results[i].both, results[i].note || ''].join('\t'));
  writeFileSync(REPORT_PATH, ['date\tcompany\tsource\tstate\tstatus\ttotal\tindia\tentry\tboth\tnote', ...rows].join('\n') + '\n');

  const ok = results.filter((r) => r.status === 'ok');
  const withBoth = ok.filter((r) => r.both > 0);
  console.log(`\nchecked ${selected.length}: ${ok.length} read, ${selected.length - ok.length} errors or no provider`);
  console.log(`with an India entry-level posting: ${withBoth.length}   scoring zero: ${ok.length - withBoth.length}`);
  console.log(`report: ${REPORT_PATH}`);

  const changes = selected.map((e, i) => ({ e, r: results[i], action: decideChange(e, results[i]) })).filter((c) => c.action);
  console.log(`--apply would enable ${changes.filter((c) => c.action === 'enable').length} and disable ${changes.filter((c) => c.action === 'disable').length}`);
  if (!opts.apply) { console.log('Preview only. Add --apply to change portals.yml.'); return; }
  if (!changes.length) { console.log('Nothing to change.'); return; }
  if (!opts.force && discoverIsRunning()) {
    console.error('Refusing to write: a discover-ats.mjs run is active and also rewrites portals.yml. Wait, or pass --force.');
    process.exit(2);
  }
  const backup = backupFile(PORTALS_PATH);
  let text = portalsText;
  for (const { e, action } of changes) {
    const note = action === 'disable' ? `disabled ${today} by board-india-check: no India entry-level postings` : '';
    text = setEnabledInText(text, e.name, action === 'enable', note).text;
  }
  atomicWrite(PORTALS_PATH, text);
  console.log(`portals.yml updated. Backup: ${backup}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err?.stack || err); process.exit(1); });
}
