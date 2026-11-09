#!/usr/bin/env node
/**
 * export-careers.mjs: turn the discovery results into one CSV that tools/apply-verified-list.mjs can apply to portals.yml.
 * Writes data/careers-export.csv (Company, Careers URL, Mode, Source). Reads only; it never edits portals.yml.
 *
 *   node tools/export-careers.mjs [--out FILE]
 *
 * Per company, the best source wins:
 *   1. your dashboard decision: a cross drops the company; a tick uses your (possibly edited) URL;
 *   2. pass 3 "switch" (the India version of the portal);
 *   3. pass 2 result: jobs-found / listings-on-page use its URL (Mode=scan);
 *      right-portal-no-india, listings-unread and india-unknown use its URL with Mode=watch (right page, but no jobs a scan can use: checked weekly, not scanned);
 *      needs-identity-check, bot-blocked, no-candidate, unresolved and the rest are left out;
 *   4. pass 1: an accepted row's URL.
 * Mode is "scan" or "watch". A company already in your hand-verified portals.yml entry is replaced only if apply-verified-list says so.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isMainModule } from '../lib/is-main-module.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';

const tsv = (text) => { const [h, ...ls] = String(text).split('\n').filter(Boolean); const cols = (h || '').split('\t'); return ls.map((l) => { const c = l.split('\t'); return Object.fromEntries(cols.map((k, i) => [k, c[i] ?? ''])); }); };
const key = (n) => String(n).toLowerCase().replace(/[^a-z0-9]/g, '');
const csvCell = (v) => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const PASS2_SCAN = new Set(['jobs-found', 'listings-on-page']); // jobs were actually read
const PASS2_WATCH = new Set(['right-portal-no-india', 'listings-unread', 'india-unknown']); // right page, but nothing a scan can use: checked weekly by hand

/** Pure: pick one {name, url, mode, source} per company from the four sources. */
export function choose({ pass1 = [], pass2 = [], pass3 = [], review = {} }) {
  const names = new Map(); const add = (n) => { if (n && !names.has(key(n))) names.set(key(n), n); };
  [...pass1, ...pass2, ...pass3].forEach((r) => add(r.company)); Object.keys(review).forEach(add);
  const p1 = new Map(pass1.map((r) => [key(r.company), r])); const p2 = new Map(pass2.map((r) => [key(r.company), r])); const p3 = new Map(pass3.map((r) => [key(r.company), r]));
  const out = [];
  for (const [k, name] of names) {
    const rv = review[name] || review[k] || {};
    if (rv.decision === 'bad') continue;
    const r3 = p3.get(k); const r2 = p2.get(k); const r1 = p1.get(k);
    const mode2 = PASS2_WATCH.has(r2?.final_status) ? 'watch' : 'scan';
    let pick = null;
    if (rv.decision === 'ok' && (rv.careers_url || r2?.careers_url || r1?.careers_url)) pick = { url: rv.careers_url || r2?.careers_url || r1.careers_url, mode: mode2, source: 'review' };
    else if (r3?.decision === 'switch' && r3.new_url) pick = { url: r3.new_url, mode: 'scan', source: 'pass3' };
    else if (r2 && (PASS2_SCAN.has(r2.final_status) || PASS2_WATCH.has(r2.final_status)) && r2.careers_url) pick = { url: r2.careers_url, mode: mode2, source: 'pass2' };
    else if (r1?.status === 'accepted' && r1.careers_url) pick = { url: r1.careers_url, mode: 'scan', source: 'pass1' };
    if (pick) out.push({ name, ...pick });
  }
  return out;
}

function main() {
  const ROOT = getCareerOpsRoot(); const D = join(ROOT, 'data');
  const rd = (f) => (existsSync(join(D, f)) ? readFileSync(join(D, f), 'utf8') : '');
  let review = {}; try { review = JSON.parse(rd('careers-review.json') || '{}'); } catch { /* none */ }
  const rows = choose({ pass1: tsv(rd('careers-discovery.tsv')), pass2: tsv(rd('careers-pass2.tsv')), pass3: tsv(rd('careers-pass3.tsv')), review });
  const i = process.argv.indexOf('--out'); const out = i >= 0 ? process.argv[i + 1] : join(D, 'careers-export.csv');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, ['Company,Careers URL,Mode,Source', ...rows.map((r) => [r.name, r.url, r.mode, r.source].map(csvCell).join(','))].join('\n') + '\n');
  const by = {}; for (const r of rows) by[`${r.source}/${r.mode}`] = (by[`${r.source}/${r.mode}`] || 0) + 1;
  console.log(`${rows.length} companies -> ${out}`, JSON.stringify(by));
}
if (isMainModule(import.meta.url)) main();
