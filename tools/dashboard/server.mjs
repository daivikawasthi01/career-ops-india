#!/usr/bin/env node
/**
 * dashboard/server.mjs: one local page for the whole job-search pipeline.
 *
 *   node tools/dashboard/server.mjs          # then open http://127.0.0.1:8790
 *
 * Reads the files the pipeline already writes (data/*.txt, *.tsv, *.json, portals.yml, data/jobs.db) and shows them
 * in one place: the discovery run, the sources and feeders, the harvested company names, the ATS boards, campus page
 * changes, the jobs found, and the mine.py runs. Two things can be changed from the page: a job's status (jobs.db)
 * and starting one feeder or scan step in the background. Nothing else is written, portals.yml is never edited here.
 * Listens on loopback only and refuses requests whose Host or Origin is not this server (DNS rebinding, other sites).
 */
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { loadYaml } from '../../lib/yaml-document.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const ROOT = process.env.CAREER_OPS_ROOT || join(resolve(REPO, '..'), 'career-ops'); // same default as the other tools/ scripts
const DATA = join(ROOT, 'data');
const PUBLIC = join(HERE, 'public');
const PORT = Number(process.env.DASHBOARD_PORT) || 8790;
const DB_FILE = process.env.DASHBOARD_DB || join(REPO, 'data', 'jobs.db');
const STATE_FILE = join(REPO, 'data', 'cache', 'mine-state.json');
const RUN_DIR = join(REPO, 'data', 'cache', 'dashboard-runs');
const PYTHON = process.env.DASHBOARD_PYTHON || ['/opt/anaconda3/bin/python', 'python3'].find((p) => p === 'python3' || existsSync(p));

/** The scan steps, from the one registry mine.py also reads (config/pipeline.yml `steps:`). */
export function stepRegistry(file = process.env.CAREER_OPS_PIPELINE_CONFIG || join(REPO, 'config', 'pipeline.yml')) {
  try { return loadYaml(readFileSync(file, 'utf8')).steps || []; } catch { return []; }
}
const LISTS = [
  { id: 'telegram', file: 'telegram-companies.txt', label: 'Telegram channels', feeder: 'telegram' },
  { id: 'funding', file: 'funding-companies.txt', label: 'Funding news', feeder: 'funding' },
  { id: 'directory', file: 'careers-directory-new-companies.txt', label: 'careersat.tech directory', feeder: 'directory' },
  { id: 'campus', file: 'campus-watchlist.txt', label: 'Campus watchlist', feeder: 'campus' },
];
const STATUSES = ['new', 'interested', 'applied', 'ignore'];

const readText = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const readJson = (p, d) => { try { return JSON.parse(readText(p) || 'null') ?? d; } catch { return d; } };
const mtime = (p) => { try { return statSync(p).mtime.toISOString(); } catch { return null; } };
const lines = (p) => readText(p).split('\n').map((l) => l.replace(/\r$/, ''));

export function parseTsv(text) {
  const [head, ...rows] = String(text).split('\n').filter((l) => l.length);
  if (!head) return [];
  const cols = head.split('\t');
  return rows.map((l) => { const c = l.split('\t'); return Object.fromEntries(cols.map((k, i) => [k, c[i] ?? ''])); });
}

export function namesOf(text) {
  return String(text).split('\n').map((l) => l.replace(/#.*/, '').split('\t')[0].trim()).filter(Boolean);
}

function tailLines(path, n) {
  const all = lines(path).filter(Boolean);
  return all.slice(-n);
}

// ---- readers ----
function yamlLoad(path) {
  try { return import('yaml').then((m) => (m.default || m).parse(readText(path)) || {}); } catch { return Promise.resolve({}); }
}

let feederCache = { at: 0, list: [] };
function feederList() {
  if (Date.now() - feederCache.at < 60000) return feederCache.list;
  const r = spawnSync(PYTHON, ['-c', 'import json,feeders;print(json.dumps(feeders.feeder_list()))'], { cwd: join(REPO, 'tools'), env: { ...process.env, CAREER_OPS_ROOT: ROOT }, encoding: 'utf8', timeout: 15000 });
  let list = [];
  try { list = JSON.parse(r.stdout || '[]').map((f) => ({ id: f.id, every: f.every, file: f.file })); } catch { /* no python: the page shows no feeders */ }
  feederCache = { at: Date.now(), list };
  return list;
}

function withDb(fn, write = false) {
  if (!existsSync(DB_FILE)) return null;
  return import('node:sqlite').then(({ DatabaseSync }) => {
    const db = new DatabaseSync(DB_FILE, { readOnly: !write });
    try { return fn(db); } finally { db.close(); }
  });
}

async function overview() {
  const status = readJson(join(DATA, 'careers-discovery.status.json'), {});
  const rows = Math.max(0, lines(join(DATA, 'careers-discovery.tsv')).filter(Boolean).length - 1);
  const supervisor = [...lines(join(DATA, 'careers-supervisor.log')), ...lines(join(DATA, 'careers-overnight.out'))].filter((l) => /^\[20\d\d-\d\d-\d\d /.test(l)).sort().slice(-5); // timestamped status lines from both logs
  const jobs = await withDb((db) => ({
    total: db.prepare('SELECT COUNT(*) n FROM jobs').get().n,
    byStatus: Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM jobs GROUP BY status').all().map((r) => [r.status, r.n])),
    employer: db.prepare("SELECT COUNT(*) n FROM jobs WHERE confidence='employer-confirmed'").get().n,
    lastRun: db.prepare('SELECT MAX(started) s FROM runs WHERE dry_run=0').get().s,
  }));
  const portals = await yamlLoad(join(ROOT, 'portals.yml'));
  const campus = readJson(join(DATA, 'campus-watch.json'), {});
  return {
    run: (() => {
      const { seconds_per_company: secs = [], ...rest } = status;
      const recent = secs.slice(-20);
      return { ...rest, rows, supervisor, avgSeconds: recent.length ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length) : null, tsvUpdated: mtime(join(DATA, 'careers-discovery.tsv')) };
    })(),
    lists: LISTS.map((l) => ({ id: l.id, label: l.label, count: namesOf(readText(join(DATA, l.file))).length, updated: mtime(join(DATA, l.file)) })),
    boards: {
      tracked: (portals.tracked_companies || []).length,
      jobBoards: (portals.job_boards || []).length,
      searchQueries: (portals.search_queries || []).length,
      reviewed: (readText(join(DATA, 'india-boards-reviewed.yml')).match(/^- name:/gm) || []).length,
      rejected: Math.max(0, lines(join(DATA, 'india-boards-rejected.tsv')).filter(Boolean).length - 1),
      probed: Math.max(0, lines(join(DATA, 'india-ats-probe.tsv')).filter(Boolean).length),
      found: Math.max(0, lines(join(DATA, 'india-ats-boards.tsv')).filter(Boolean).length - 1),
    },
    campus: { pages: Object.keys(campus).length, changes: Math.max(0, lines(join(DATA, 'campus-watch-changes.tsv')).filter(Boolean).length - 1) },
    jobs: jobs || { total: 0, byStatus: {}, employer: 0, lastRun: null, empty: true },
    probeRunning: pgrep('probe-india-ats'),
  };
}

function pgrep(pattern) {
  const r = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim().length > 0;
}

async function sources() {
  const state = readJson(STATE_FILE, {});
  const portals = await yamlLoad(join(ROOT, 'portals.yml'));
  const stateOf = (id) => (state[id] ? { at: state[id].at, coverage: state[id].coverage } : null);
  const feeders = feederList().map((f) => ({ kind: 'feeder', id: f.id, detail: `every ${f.every} days`, last: stateOf(f.id), runnable: true }));
  const steps = stepRegistry().map((e) => ({ kind: 'step', id: e.id, detail: e.label, standalone: !!e.standalone, last: stateOf(e.state_id || e.id), runnable: true }));
  const boards = (portals.job_boards || []).map((b) => ({ kind: 'board', id: b.name, detail: b.provider || (b.api ? 'api' : 'board'), enabled: b.enabled !== false, runnable: false }));
  return { feeders, steps, boards, stateFile: mtime(STATE_FILE) };
}

function list(id, q, limit) {
  const def = LISTS.find((l) => l.id === id);
  if (!def) return null;
  const all = namesOf(readText(join(DATA, def.file)));
  const needle = String(q || '').toLowerCase();
  const hits = needle ? all.filter((n) => n.toLowerCase().includes(needle)) : all;
  return { id, label: def.label, file: def.file, total: all.length, shown: hits.slice(0, limit), updated: mtime(join(DATA, def.file)) };
}

function boards(kind) {
  if (kind === 'rejected') return parseTsv(readText(join(DATA, 'india-boards-rejected.tsv')));
  if (kind === 'found') return parseTsv(readText(join(DATA, 'india-ats-boards.tsv')));
  if (kind === 'verified') return parseTsv(readText(join(DATA, 'directory-boards.tsv'))).filter((r) => r.verdict === 'ok');
  const y = readText(join(DATA, 'india-boards-reviewed.yml'));
  return [...y.matchAll(/- name: "([^"]*)"\n\s+careers_url: (\S+)\n\s+notes: "([^"]*)"/g)].map((m) => ({ company: m[1], url: m[2], notes: m[3] }));
}

function campus() {
  const changes = parseTsv(readText(join(DATA, 'campus-watch-changes.tsv'))).reverse().slice(0, 200);
  const watch = readJson(join(DATA, 'campus-watch.json'), {});
  const pages = Object.entries(watch).map(([url, p]) => ({ url, signals: (p?.signals || []).join(', '), lastOk: p?.last_ok || '', fails: p?.fails || 0, error: p?.last_error || '' }));
  pages.sort((a, b) => (b.fails > 0) - (a.fails > 0) || a.url.localeCompare(b.url));
  return { changes, pages: pages.slice(0, 400), pageCount: pages.length, failing: pages.filter((p) => p.fails > 0).length };
}

async function jobs(params) {
  const status = STATUSES.includes(params.get('status')) ? params.get('status') : '';
  const q = `%${(params.get('q') || '').toLowerCase()}%`;
  const limit = Math.min(Number(params.get('limit')) || 100, 500);
  const out = await withDb((db) => {
    const where = ['1=1']; const args = [];
    if (status) { where.push('status = ?'); args.push(status); }
    if (params.get('q')) { where.push('(lower(title) LIKE ? OR lower(company) LIKE ? OR lower(location) LIKE ?)'); args.push(q, q, q); }
    const sql = `SELECT canonical_url, url, employer_url, company, title, location, posted, stipend, first_seen, found_by, confidence, status, flags FROM jobs WHERE ${where.join(' AND ')} ORDER BY first_seen DESC, rowid DESC LIMIT ${limit}`;
    return db.prepare(sql).all(...args);
  });
  return out || [];
}

async function setJobStatus(canonical, status) {
  if (!STATUSES.includes(status) || !canonical) throw httpErr(400, 'bad status or job');
  const n = await withDb((db) => db.prepare('UPDATE jobs SET status = ? WHERE canonical_url = ?').run(status, canonical).changes, true);
  if (n == null) throw httpErr(404, 'no jobs database yet');
  return { changed: Number(n) };
}

async function runs() {
  const fromDb = await withDb((db) => db.prepare('SELECT run_id, source, started, ended, status, fetched, kept, new, duplicates, errors, error, seconds, health, dry_run FROM runs ORDER BY started DESC LIMIT 120').all());
  const logs = existsSync(join(REPO, 'output', 'logs')) ? readdirSync(join(REPO, 'output', 'logs')).filter((f) => f.startsWith('mine-')).sort().reverse().slice(0, 15) : [];
  return { runs: fromDb || [], logs, started: [...started.values()].map((r) => ({ id: r.id, target: r.target, dry: r.dry, at: r.at, running: r.running })).reverse() };
}

// ---- background runs ----
const started = new Map();
export function runnable(id) {
  return stepRegistry().some((e) => e.id === id) || feederList().some((f) => f.id === id);
}
/**
 * Start one mine.py run in the background. `steps` empty = the complete run (every step, plus the feeders that are due);
 * otherwise exactly those steps and feeders. A run is a DRY run unless `dry` is the literal `false`: a real run writes
 * jobs.db, advances the schedule and sends Telegram pings. Only one run at a time, since they share jobs.db and the state file.
 */
export function startRun({ steps = [], dry = true, unknown = [] } = {}) {
  if (unknown.length) throw httpErr(400, `unknown field: ${unknown.join(', ')}`); // never start a run from a body we did not understand
  if (!Array.isArray(steps)) throw httpErr(400, 'steps must be a list of step or feeder ids');
  const list = steps.map(String);
  for (const id of list) if (!runnable(id)) throw httpErr(400, `not a runnable source: ${id}`);
  if ([...started.values()].some((r) => r.running)) throw httpErr(409, 'a mine.py run is already in progress');
  const alone = stepRegistry().find((e) => e.standalone && list.includes(e.id));
  if (alone && list.length > 1) throw httpErr(400, `${alone.id} runs on its own: pick it without other steps`);
  const isDry = dry !== false;
  const args = ['tools/mine.py', ...(isDry ? ['--dry-run'] : []),
    ...(alone ? [alone.cli] : list.length ? ['--steps', [...new Set(list)].join(',')] : [])];
  mkdirSync(RUN_DIR, { recursive: true });
  const target = `${isDry ? 'dry run' : 'real run'}: ${list.length ? list.join(', ') : 'everything'}`;
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${isDry ? 'dry' : 'real'}`;
  const logPath = join(RUN_DIR, `${runId}.log`);
  const fd = openSync(logPath, 'a');
  const child = spawn(PYTHON, args, { cwd: REPO, env: { ...process.env, CAREER_OPS_ROOT: ROOT }, stdio: ['ignore', fd, fd], detached: true });
  closeSync(fd);
  const rec = { id: runId, target, dry: isDry, at: new Date().toISOString(), running: true, logPath };
  started.set(runId, rec);
  child.on('exit', (code) => { rec.running = false; rec.code = code; });
  child.on('error', (e) => { rec.running = false; rec.code = -1; writeFileSync(logPath, `could not start: ${e.message}\n`, { flag: 'a' }); });
  child.unref();
  return { runId, target };
}
function runLog(runId) {
  const rec = started.get(runId);
  if (!rec) throw httpErr(404, 'unknown run');
  const text = readText(rec.logPath).replace(/\r/g, '\n').split('\n').filter((l) => l && !/\d+%\|/.test(l)).slice(-120).join('\n');
  return { id: rec.id, target: rec.target, dry: rec.dry, running: rec.running, code: rec.code ?? null, log: text };
}

// ---- http ----
function httpErr(status, message) { return Object.assign(new Error(message), { status }); }
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

export function hostOk(req, port = PORT) {
  const ok = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!ok.has(String(req.headers.host || '').toLowerCase())) return false;
  const origin = req.headers.origin;
  return !origin || ok.has(String(origin).replace(/^https?:\/\//, '').toLowerCase());
}

async function body(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 20000) throw httpErr(413, 'body too large'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw httpErr(400, 'body is not JSON'); }
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const send = (obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  if (p === '/api/overview') return send(await overview());
  if (p === '/api/sources') return send(await sources());
  if (p.startsWith('/api/list/')) { const r = list(p.slice(10), url.searchParams.get('q'), Math.min(Number(url.searchParams.get('limit')) || 300, 2000)); return r ? send(r) : send({ error: 'unknown list' }, 404); }
  if (p === '/api/boards') return send(boards(url.searchParams.get('kind') || 'reviewed'));
  if (p === '/api/campus') return send(campus());
  if (p === '/api/jobs' && req.method === 'GET') return send(await jobs(url.searchParams));
  if (p === '/api/jobs/status' && req.method === 'POST') { const b = await body(req); return send(await setJobStatus(b.canonical_url, b.status)); }
  if (p === '/api/runs') return send(await runs());
  if (p === '/api/run' && req.method === 'POST') { const b = await body(req); return send(startRun({ steps: b.steps ?? [], dry: b.dry, unknown: Object.keys(b).filter((k) => !['steps', 'dry'].includes(k)) })); }
  if (p.startsWith('/api/run/')) return send(runLog(decodeURIComponent(p.slice(9))));
  if (p.startsWith('/api/')) return send({ error: 'not found' }, 404);
  const file = p === '/' ? 'index.html' : p.slice(1);
  const full = resolve(PUBLIC, file);
  if (!full.startsWith(PUBLIC + '/') || !existsSync(full) || !statSync(full).isFile()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(full)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(full));
}

export function createDashboard(port = PORT) {
  return createServer((req, res) => {
    if (!hostOk(req, port)) { res.writeHead(403); return res.end('forbidden'); }
    route(req, res).catch((e) => {
      const status = e.status || 500;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: status === 500 ? 'internal error' : e.message }));
      if (status === 500) console.error(e);
    });
  });
}

if (isMainModule(import.meta.url)) {
  createDashboard().listen(PORT, '127.0.0.1', () => console.log(`dashboard: http://127.0.0.1:${PORT}  (data ${DATA})`));
}
