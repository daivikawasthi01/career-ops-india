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
 * disabled and are always enabled (with `watch: true` while they have no entry-level posting). A board with 3 or
 * fewer postings in total is never auto-disabled: it is listed in data/check-by-hand.txt. A board that gains an
 * India entry-level posting loses `watch`. Every auto-disable adds `# auto-disabled <date> by
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
import { writeSection } from './lib/check-by-hand.mjs';
import { discoverIsRunning, backupFile, atomicWrite, setEnabledInText, setFieldInText, removeFieldInText, autoDisabledNames } from './lib/portals-edit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || join(HERE, 'portals.yml');
const REPORT_PATH = join(HERE, 'data', 'cache', 'board-india-check.tsv');
// One name per line, # comments: boards that stay enabled and watched whatever the counts say.
const CHECK_BY_HAND_PATH = process.env.CAREER_OPS_CHECK_BY_HAND || join(HERE, 'data', 'check-by-hand.txt');
/** A board that returns this few postings or fewer is probably not being read in full: zero proves nothing. */
export const SMALL_BOARD_MAX = 3;
const REMOTE_RE = /\b(remote|anywhere|worldwide|global|apac|asia|work from home|wfh)\b/i;
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
  let remoteOpen = 0;
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const inIndia = Boolean(locationFilter(job.location, job.url, job.title, job));
    const entryLevel = Boolean(titleFilter(job.title));
    // Not counted as India, but the location or title says remote / anywhere / APAC: possibly open to an Indian candidate.
    if (!inIndia && (REMOTE_RE.test(job.location || '') || REMOTE_RE.test(job.title || ''))) remoteOpen++;
    if (inIndia) india++;
    if (entryLevel) entry++;
    if (inIndia && entryLevel) both++;
  }
  // india_any: passes the location filter at any level. india_entry: passes both filters.
  return { total: Array.isArray(jobs) ? jobs.length : 0, india, entry, both, india_any: india, india_entry: both, remote_open: remoteOpen };
}

/**
 * What --apply should do for one checked entry, or null for no change. Pure.
 *
 *   disable        enabled, india_any = 0, and the board returned more than SMALL_BOARD_MAX postings
 *   check-by-hand  the same, but a board that small is probably not read in full: listed, never disabled
 *   watch          enabled, india_any > 0, india_entry = 0
 *   unwatch        carries `watch: true` but has india_entry > 0: ordinary scans already find its roles
 *   enable         disabled `source: jobradar` board that now has an India entry-level posting
 *   enable-watch   a protected board that is off and has no entry-level posting yet
 * Protected boards are never disabled and are always enabled. Errors are never read as zero.
 */
export function decideChange(entry, result, { protectedSet = new Set(), smallMax = SMALL_BOARD_MAX } = {}) {
  if (result.status !== 'ok') return null;
  const enabled = entry.enabled !== false;
  const any = result.india_any ?? result.india ?? 0;
  const ent = result.india_entry ?? result.both ?? 0;
  const watched = entry.watch === true;
  if (protectedSet.has(String(entry.name).toLowerCase())) {
    if (!enabled) return ent > 0 ? 'enable' : 'enable-watch';
    if (ent > 0) return watched ? 'unwatch' : null;
    return watched ? null : 'watch';
  }
  if (enabled && any === 0) return (result.total ?? 0) <= smallMax ? 'check-by-hand' : 'disable';
  if (enabled && ent > 0 && watched) return 'unwatch';
  if (enabled && any > 0 && ent === 0 && !watched) return 'watch';
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
    results[i].india_any ?? '', results[i].india_entry ?? '', results[i].remote_open ?? '', decide(e, results[i]) || '', results[i].note || ''].join('\t'));
  writeFileSync(REPORT_PATH, ['date\tcompany\tsource\tstate\tstatus\ttotal\tindia\tentry\tboth\tindia_any\tindia_entry\tremote_open\taction\tnote', ...rows].join('\n') + '\n');

  const ok = results.filter((r) => r.status === 'ok');
  const withBoth = ok.filter((r) => r.both > 0);
  console.log(`\nchecked ${selected.length}: ${ok.length} read, ${selected.length - ok.length} errors or no provider`);
  console.log(`with an India entry-level posting: ${withBoth.length}   scoring zero: ${ok.length - withBoth.length}`);
  console.log(`report: ${REPORT_PATH}`);

  const changes = selected.map((e, i) => ({ e, r: results[i], action: decide(e, results[i]) })).filter((c) => c.action);
  const by = (a) => changes.filter((c) => c.action === a);
  console.log(`--apply would: disable ${by('disable').length} (india_any=0, more than ${SMALL_BOARD_MAX} postings), `
    + `list ${by('check-by-hand').length} small boards for a manual check, watch ${by('watch').length}, unwatch ${by('unwatch').length}, `
    + `enable ${by('enable').length}, enable+watch ${by('enable-watch').length}, re-enable ${by('reenable').length}`);
  // Small boards are never disabled on a zero count; they go to a file for a person to look at.
  if (by('check-by-hand').length) {
    writeSection(CHECK_BY_HAND_PATH, 'small-boards', [
      '# Boards with no India posting but 3 or fewer postings in total: probably not read in full. name<TAB>postings<TAB>careers_url',
      ...by('check-by-hand').map((c) => `${c.e.name}\t${c.r.total}\t${c.e.careers_url || c.e.api || ''}`)]);
    console.log(`check-by-hand list (${by('check-by-hand').length}): ${CHECK_BY_HAND_PATH}`);
  }
  if (!opts.apply) {
    for (const a of ['disable', 'check-by-hand', 'watch', 'unwatch', 'enable', 'enable-watch', 'reenable']) {
      if (by(a).length) console.log(`\n${a} (${by(a).length}):\n  ${by(a).map((c) => `${c.e.name} [any ${c.r.india_any}, entry ${c.r.india_entry}, of ${c.r.total}${c.r.remote_open ? `, remote-ish ${c.r.remote_open}` : ''}]`).join('\n  ')}`);
    }
    const remoteOpen = by('disable').filter((c) => c.r.remote_open > 0);
    if (remoteOpen.length) console.log(`\nwould disable but have remote/APAC-looking postings that are not counted as India (${remoteOpen.length}): ${remoteOpen.map((c) => `${c.e.name} (${c.r.remote_open})`).join(', ')}`);
    console.log('\nPreview only. Add --apply to change portals.yml.');
    return;
  }
  if (!changes.some((c) => c.action !== 'check-by-hand')) { console.log('Nothing to change.'); return; }
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
    if (action === 'unwatch') text = removeFieldInText(text, e.name, 'watch').text;
  }
  atomicWrite(PORTALS_PATH, text);
  console.log(`portals.yml updated. Backup: ${backup}`);
}

if (isMainModule(import.meta.url)) {
  // Exit explicitly: one board whose connection never closes would otherwise keep the process alive long after
  // the report is printed and written (a finished run was seen hanging for 30+ minutes).
  main().then(() => process.exit(process.exitCode ?? 0)).catch((err) => { console.error(err?.stack || err); process.exit(1); });
}
