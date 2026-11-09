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
 *   node board-india-check.mjs --recheck-disabled        # re-test boards this tool auto-disabled; --apply re-enables those with any India posting
 *
 * Criterion (--apply): disable only when india_any = 0 (nothing located in India at any level). india_any > 0 with
 * india_entry = 0 stays enabled and gets `watch: true`. Boards listed in config/protected-boards.txt are never
 * disabled and are always enabled with `watch: true`. Every auto-disable adds `# auto-disabled <date> by
 * board-india-check (india_any=0)`.
 *   options: --limit N  --concurrency N (default 6)  --force (apply while discover-ats runs)
 *
 * Re-enabling is limited to boards tagged `source: jobradar`; boards you disabled yourself are
 * never switched back on. portals.yml is only written with --apply, after a backup.
 * The report goes to data/cache/board-india-check.tsv.
 */

import { isMainModule } from './lib/is-main-module.mjs';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { loadYaml } from './lib/yaml-document.mjs';
import { loadProviders, resolveProvider } from './providers/_registry.mjs';
import { makeHttpCtx } from './providers/_http.mjs';
import { buildTitleFilter, buildLocationFilter } from './scan.mjs';
import { applyPipelineConfig } from './lib/pipeline-config.mjs';
import { discoverIsRunning, backupFile, atomicWrite, setEnabledInText, setFieldInText, autoDisabledNames } from './lib/portals-edit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || join(HERE, 'portals.yml');
const REPORT_PATH = join(HERE, 'data', 'cache', 'board-india-check.tsv');
// One name per line, # comments: boards that stay enabled and watched whatever the counts say.
const PROTECTED_PATH = process.env.CAREER_OPS_PROTECTED || join(HERE, 'config', 'protected-boards.txt');

export function loadProtected(path = PROTECTED_PATH) {
  if (!existsSync(path)) return new Set();
  return new Set(readFileSync(path, 'utf-8').split('\n').map((l) => l.replace(/#.*/, '').trim().toLowerCase()).filter(Boolean));
}

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
  // india_any: passes the location filter at any level. india_entry: passes both filters.
  return { total: Array.isArray(jobs) ? jobs.length : 0, india, entry, both, india_any: india, india_entry: both };
}

/**
 * What --apply should do for one checked entry, or null for no change. Pure.
 *
 *   disable       enabled, india_any = 0 (nothing in India at any level)
 *   watch         enabled, india_any > 0 but india_entry = 0: stays on, flagged `watch: true`
 *   enable        disabled `source: jobradar` board that now has an India entry-level posting
 *   enable-watch  a protected board that is off: protected boards are always on and watched
 * Protected boards are never disabled. Errors are never read as zero.
 */
export function decideChange(entry, result, { protectedSet = new Set() } = {}) {
  if (result.status !== 'ok') return null;
  const enabled = entry.enabled !== false;
  const any = result.india_any ?? result.india ?? 0;
  const ent = result.india_entry ?? result.both ?? 0;
  if (protectedSet.has(String(entry.name).toLowerCase())) {
    if (!enabled) return 'enable-watch';
    return entry.watch === true ? null : 'watch';
  }
  if (enabled && any === 0) return 'disable';
  if (enabled && any > 0 && ent === 0 && entry.watch !== true) return 'watch';
  if (!enabled && ent > 0 && entry.source === 'jobradar') return 'enable';
  return null;
}

/** --recheck-disabled: an auto-disabled board comes back when it now has any India posting. */
export function decideRecheck(entry, result) {
  if (result.status !== 'ok' || entry.enabled !== false) return null;
  return (result.india_any ?? result.india ?? 0) > 0 ? 'reenable' : null;
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
    recheck: argv.includes('--recheck-disabled'),
    source: get('--source'),
    company: get('--company'),
    limit: Number(get('--limit')) || 0,
    concurrency: Number(get('--concurrency')) || 6,
  };
}

const USAGE = `usage: board-india-check.mjs (--source NAME | --company NAME | --disabled | --all | --recheck-disabled) [--apply]
  --source NAME     boards tagged with that source (for example jobradar)
  --company NAME    one board
  --disabled | --all  other selections
  --recheck-disabled  re-test the boards this tool auto-disabled (monthly); --apply re-enables those with any India posting
  --apply           write portals.yml (backup first); without it this is a preview
  --limit N  --concurrency N (default 6)  --force
  --help, -h        print this and exit (fetches nothing, writes nothing)`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return; }
  const opts = parseArgs(argv);
  if (!(opts.all || opts.disabled || opts.source || opts.company || opts.recheck)) {
    console.error('Pick a selection: --source jobradar | --company NAME | --disabled | --all | --recheck-disabled\n(see --help)');
    process.exit(1);
  }
  if (!existsSync(PORTALS_PATH)) { console.error(`Error: ${PORTALS_PATH} not found.`); process.exit(1); }
  if (!process.env.CAREER_OPS_HTTP_TIMEOUT_MS) process.env.CAREER_OPS_HTTP_TIMEOUT_MS = '30000';

  const portalsText = readFileSync(PORTALS_PATH, 'utf-8');
  const config = applyPipelineConfig(loadYaml(portalsText) || {});
  const entries = (config.tracked_companies || []).filter((e) => e && typeof e.name === 'string');
  const autoOff = opts.recheck ? new Set(autoDisabledNames(portalsText)) : null;
  let selected = entries.filter((e) => {
    if (opts.recheck) return e.enabled === false && autoOff.has(e.name);
    if (opts.company) return e.name.toLowerCase() === opts.company.toLowerCase();
    if (opts.source) return e.source === opts.source;
    if (opts.disabled) return e.enabled === false;
    return true;
  });
  if (opts.limit) selected = selected.slice(0, opts.limit);
  if (!selected.length) { console.log('No entries match that selection.'); return; }
  const protectedSet = loadProtected();

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
  const decide = (e, r) => (opts.recheck ? decideRecheck(e, r) : decideChange(e, r, { protectedSet }));
  const rows = selected.map((e, i) => [today, e.name, e.source || '', e.enabled === false ? 'disabled' : 'enabled',
    results[i].status, results[i].total, results[i].india, results[i].entry, results[i].both,
    results[i].india_any ?? '', results[i].india_entry ?? '', decide(e, results[i]) || '', results[i].note || ''].join('\t'));
  writeFileSync(REPORT_PATH, ['date\tcompany\tsource\tstate\tstatus\ttotal\tindia\tentry\tboth\tindia_any\tindia_entry\taction\tnote', ...rows].join('\n') + '\n');

  const ok = results.filter((r) => r.status === 'ok');
  const withBoth = ok.filter((r) => r.both > 0);
  console.log(`\nchecked ${selected.length}: ${ok.length} read, ${selected.length - ok.length} errors or no provider`);
  console.log(`with an India entry-level posting: ${withBoth.length}   scoring zero: ${ok.length - withBoth.length}`);
  console.log(`report: ${REPORT_PATH}`);

  const changes = selected.map((e, i) => ({ e, r: results[i], action: decide(e, results[i]) })).filter((c) => c.action);
  const by = (a) => changes.filter((c) => c.action === a);
  console.log(`--apply would: disable ${by('disable').length} (india_any=0), watch ${by('watch').length} (india_any>0, india_entry=0), `
    + `enable ${by('enable').length}, enable+watch ${by('enable-watch').length}, re-enable ${by('reenable').length}`);
  if (!opts.apply) {
    for (const a of ['disable', 'watch', 'enable', 'enable-watch', 'reenable']) {
      if (by(a).length) console.log(`\n${a} (${by(a).length}):\n  ${by(a).map((c) => `${c.e.name} [any ${c.r.india_any}, entry ${c.r.india_entry}, of ${c.r.total}]`).join('\n  ')}`);
    }
    console.log('\nPreview only. Add --apply to change portals.yml.');
    return;
  }
  if (!changes.length) { console.log('Nothing to change.'); return; }
  if (!opts.force && discoverIsRunning()) {
    console.error('Refusing to write: a discover-ats.mjs run is active and also rewrites portals.yml. Wait, or pass --force.');
    process.exit(2);
  }
  const backup = backupFile(PORTALS_PATH);
  let text = portalsText;
  for (const { e, r, action } of changes) {
    if (action === 'disable') text = setEnabledInText(text, e.name, false, `auto-disabled ${today} by board-india-check (india_any=0)`).text;
    else if (action === 'reenable') text = setEnabledInText(text, e.name, true, `re-enabled ${today} by board-india-check --recheck-disabled (india_any=${r.india_any})`).text;
    else if (action === 'enable' || action === 'enable-watch') text = setEnabledInText(text, e.name, true, '').text;
    if (action === 'watch' || action === 'enable-watch') text = setFieldInText(text, e.name, 'watch', 'true').text;
  }
  atomicWrite(PORTALS_PATH, text);
  console.log(`portals.yml updated. Backup: ${backup}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => { console.error(err?.stack || err); process.exit(1); });
}
