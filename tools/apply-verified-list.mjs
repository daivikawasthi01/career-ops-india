#!/usr/bin/env node
/**
 * apply-verified-list.mjs: make portals.yml (the list scan.mjs queries) follow a hand-verified CSV of careers URLs.
 *
 *   node tools/apply-verified-list.mjs FILE.csv            # preview, writes nothing
 *   node tools/apply-verified-list.mjs FILE.csv --write    # backup, then edit portals.yml
 *
 * CSV columns used: Company, Careers URL (others are ignored). Per row:
 *   - company already in portals.yml: careers_url becomes the CSV URL, a stale `api:` line is dropped (the provider reads the URL),
 *     the entry is switched on;
 *   - company missing: appended to tracked_companies, enabled;
 *   - no scan provider reads the URL (a company's own site): the entry is kept with `watch: true`, so the weekly tab opener lists it
 *     instead of the scanner silently skipping it.
 * Text edits only (comments and layout survive). Refuses while discover-ats.mjs runs. Backup: portals.yml.bak-<timestamp>.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { isMainModule } from '../lib/is-main-module.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { loadYaml } from '../lib/yaml-document.mjs';
import { setFieldInText, setEnabledInText, removeFieldInText, backupFile, atomicWrite, discoverIsRunning } from '../lib/portals-edit.mjs';

export function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  const [head, ...rest] = rows.filter((r) => r.some(Boolean));
  return rest.map((r) => Object.fromEntries(head.map((k, i) => [k.trim(), (r[i] ?? '').trim()])));
}

const SUFFIX = /(incorporated|inc|llc|ltd|limited|corporation|corp|technologies|technology|pvt|private)$/;
export const norm = (s) => { let n = String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, ''); while (SUFFIX.test(n) && n.length > 6) n = n.replace(SUFFIX, ''); return n; };
const yamlName = (n) => (/[:#,"'&]|^\s|\s$/.test(n) ? JSON.stringify(n) : n);

/** Decide each CSV row against the entries in portals.yml. env.hasProvider(entry) says whether a scan provider reads the URL. */
export function plan(rows, entries, hasProvider) {
  const byNorm = new Map(); for (const e of entries) if (!byNorm.has(norm(e.name))) byNorm.set(norm(e.name), e);
  const out = [];
  for (const r of rows) {
    const name = r.Company; const url = r['Careers URL'];
    if (!name || !/^https?:\/\//.test(url || '')) { out.push({ name, kind: 'skip', why: 'no usable URL' }); continue; }
    const ex = byNorm.get(norm(name));
    const watch = r.Mode === 'watch' || !hasProvider({ name, careers_url: url }); // Mode=watch: right portal, nothing in India now
    const same = ex && String(ex.careers_url || '').replace(/\/$/, '') === url.replace(/\/$/, '');
    out.push({ name, url, existing: ex?.name, old: ex?.careers_url, kind: !ex ? 'add' : same && ex.enabled !== false ? 'same' : 'replace', watch, hadApi: Boolean(ex?.api), wasOff: ex?.enabled === false });
  }
  return out;
}

export function applyPlan(text, items, stamp) {
  let t = text; const added = [];
  for (const it of items) {
    if (it.kind === 'replace' || it.kind === 'same') {
      let r = setFieldInText(t, it.existing, 'careers_url', it.url); t = r.text;
      if (it.hadApi) t = removeFieldInText(t, it.existing, 'api').text;
      if (it.kind === 'replace') t = setEnabledInText(t, it.existing, true, `careers_url set from the hand-verified list ${stamp}`).text;
      if (it.watch) t = setFieldInText(t, it.existing, 'watch', 'true').text;
    } else if (it.kind === 'add') {
      added.push(`  - name: ${yamlName(it.name)}\n    careers_url: ${it.url}\n    enabled: true\n    # added from the hand-verified list ${stamp}${it.watch ? '\n    watch: true' : ''}\n`);
    }
  }
  if (added.length) {
    const at = t.search(/^job_boards:/m);
    const block = `\n  # -- hand-verified careers URLs (${stamp}) --\n${added.join('\n')}\n`;
    t = at >= 0 ? `${t.slice(0, at).replace(/\n*$/, '\n')}${block}${t.slice(at)}` : `${t.replace(/\n*$/, '\n')}${block}`;
  }
  return t;
}

async function main() {
  const file = process.argv[2];
  if (!file || !existsSync(file)) { console.error('usage: apply-verified-list.mjs FILE.csv [--write]'); process.exit(1); }
  const PORTALS = process.env.CAREER_OPS_PORTALS || join(getCareerOpsRoot(), 'portals.yml');
  const text = readFileSync(PORTALS, 'utf8');
  const entries = loadYaml(text).tracked_companies || [];
  const REPO = join(dirname(new URL(import.meta.url).pathname), '..');
  const { loadProviders, resolveProvider } = await import('../providers/_registry.mjs');
  const providers = await loadProviders(join(REPO, 'providers'));
  const hasProvider = (e) => { const p = resolveProvider(e, providers); return Boolean(p && !p.error); };
  const items = plan(parseCsv(readFileSync(file, 'utf8')), entries, hasProvider);
  const n = (k) => items.filter((i) => i.kind === k).length;
  console.log(`rows ${items.length}: replace ${n('replace')}, add ${n('add')}, already same ${n('same')}, skipped ${n('skip')}; no scan provider (watch) ${items.filter((i) => i.watch).length}; were off, now on ${items.filter((i) => i.wasOff).length}`);
  for (const i of items.filter((x) => x.kind === 'replace').slice(0, 400)) console.log(`  ${i.name}: ${i.old} -> ${i.url}${i.watch ? '  [watch]' : ''}`);
  for (const i of items.filter((x) => x.kind === 'skip')) console.log(`  skipped ${i.name}: ${i.why}`);
  if (!process.argv.includes('--write')) { console.log('preview only; add --write to edit portals.yml'); return; }
  if (discoverIsRunning()) { console.error('discover-ats.mjs is running; it also rewrites portals.yml. Try again when it ends.'); process.exit(1); }
  const backup = backupFile(PORTALS);
  atomicWrite(PORTALS, applyPlan(text, items, new Date().toISOString().slice(0, 10)));
  console.log(`written. backup: ${backup}`);
}
if (isMainModule(import.meta.url)) main().catch((e) => { console.error(e); process.exit(1); });
