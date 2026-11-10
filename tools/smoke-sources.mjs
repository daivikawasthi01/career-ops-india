#!/usr/bin/env node
/**
 * smoke-sources.mjs: small end-to-end check of every source that feeds a mine.py run.
 * Each provider is fetched with a one-page budget and must return at least one job with a title, an https URL and a
 * company or location; each feeder tool runs on a tiny input in a throw-away data root. Prints one line per source and
 * exits 1 if any FAIL. A source that fails here is broken, blocked or offline; the line says which.
 *
 *   node tools/smoke-sources.mjs                 everything
 *   node tools/smoke-sources.mjs unstop hirist   only these ids
 *   node tools/smoke-sources.mjs --providers     only providers  |  --feeders  only feeders
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, cpSync, existsSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { makeHttpCtx } from '../providers/_http.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const JOBAPPLY = resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const only = argv.filter((a) => !a.startsWith('--'));
const wantP = !argv.includes('--feeders'), wantF = !argv.includes('--providers');

const PROVIDERS = [
  ['unstop', 'unstop', { name: 'Unstop', opportunity: 'jobs' }],
  ['instahyre', 'instahyre', { name: 'Instahyre', years: 0, maxPages: 1 }],
  ['hirist', 'hirist', { name: 'Hirist', keywords: ['python'], pages: 1 }],
  ['offcampusjobs4u', 'offcampus-rss', { name: 'x', feed: 'https://offcampusjobs4u.com/feed/' }],
  ['freshersdunia', 'offcampus-rss', { name: 'x', feed: 'https://freshersdunia.in/feed/' }],
  ['freshershunt', 'offcampus-rss', { name: 'x', feed: 'https://freshershunt.in/feed/' }],
  ['yc', 'yc', { name: 'YC' }],
  ['freshersnow', 'offcampus-rss', { name: 'x', feed: 'https://www.freshersnow.com/feed/' }],
  ['remoteok', 'remoteok', { name: 'RemoteOK' }],
  ['remotive', 'remotive', { name: 'Remotive' }],
  ['weworkremotely', 'weworkremotely', { name: 'WWR' }],
  ['hackernews', 'hackernews', { name: 'HN' }],
];
const FEEDERS = [
  ['directory', 'import-careers-directory.mjs', []],
  ['telegram', 'telegram-companies.mjs', ['--pages', '1', '--channels', 'freshershunt']],
  ['funding', 'funding-companies.mjs', ['--days', '14']],
  ['campus', 'watch-campus.mjs', ['--limit', '5']],
  ['ats-tenants', 'probe-india-ats.mjs', ['--limit', '5', '--vendors', 'keka']],
  ['boards', 'classify-directory-boards.mjs', ['--limit', '5']],
  ['boards-review', 'review-india-boards.mjs', ['--apply']],
];
process.env.CAREER_OPS_HTTP_TIMEOUT_MS ||= '30000'; // slow sites and links must not read as broken providers
let bad = 0;
const line = (id, ok, note) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(16)} ${note}`); };

if (wantP) for (const [id, providerId, entry] of PROVIDERS) {
  if (only.length && !only.includes(id) && !only.includes(providerId)) continue;
  const t = Date.now();
  try {
    const provider = (await import(`../providers/${providerId}.mjs`)).default;
    const ctx = makeHttpCtx(); ctx.maxPages = 1;
    let jobs;
    try { jobs = await provider.fetch(entry, ctx); }
    catch (e) { // one retry: a network blip must not read as a broken provider
      if (!/fetch failed|aborted|timed? ?out|ECONN|ENOTFOUND/i.test(String(e?.message || e))) throw e;
      await new Promise((r) => setTimeout(r, 3000)); jobs = await provider.fetch(entry, makeHttpCtx());
    }
    const good = jobs.filter((j) => j.title && /^https:\/\//.test(j.url) && (j.company || j.location));
    line(id, good.length > 0, `${jobs.length} jobs (${good.length} well-formed) in ${Math.round((Date.now() - t) / 1000)}s${good[0] ? `, e.g. "${good[0].title.slice(0, 50)}" at ${good[0].company || '?'}` : ''}`);
  } catch (e) { const c = e?.cause; line(id, false, (String(e?.message || e).split('\n')[0] + (c ? ` [cause: ${c.code || c.name || ''} ${String(c.message || '').slice(0, 60)}]` : '')).slice(0, 200)); }
}

if (wantF) {
  const scratch = mkdtempSync(join(tmpdir(), 'smoke-root-'));
  // a scratch data root seeded with the real discovery inputs, so feeders never touch your real files
  for (const f of ['careers-discovery.tsv', 'campus-watchlist.txt']) { const src = join(JOBAPPLY, 'career-ops', 'data', f); if (existsSync(src)) { cpSync(src, join(scratch, 'data', f)); } }
  if (existsSync(join(JOBAPPLY, 'career-ops', 'portals.yml'))) cpSync(join(JOBAPPLY, 'career-ops', 'portals.yml'), join(scratch, 'portals.yml'));
  for (const [id, file, args] of FEEDERS) {
    if (only.length && !only.includes(id)) continue;
    const t = Date.now();
    const r = spawnSync('node', [join(HERE, file), ...args], { env: { ...process.env, CAREER_OPS_ROOT: scratch }, encoding: 'utf8', timeout: 240000 });
    const last = ((r.stdout || '') + (r.stderr || '')).split('\n').filter(Boolean).pop() || '';
    line(id, r.status === 0, `${last.slice(0, 130)} (${Math.round((Date.now() - t) / 1000)}s)`);
  }
  rmSync(scratch, { recursive: true, force: true });
}
console.log(bad ? `\n${bad} source(s) FAILED` : '\nall sources passed');
process.exit(bad ? 1 : 0);
