#!/usr/bin/env node
/**
 * review-india-boards.mjs: turn the raw tenant-probe and directory-verification results into a reviewed list of
 * boards that are safe to scan, and (with --apply) add them to portals.yml.
 *
 * A board is kept only when
 *   - it answered with postings and at least one is in India, and
 *   - its company name matches: the host came from the careersat.tech directory (a curated "official careers page"
 *     list), or the tenant label matches the company name (whole name, or the name starts with the label).
 * Boards whose label merely resembles a short or generic name ("aha", "benchmark") are rejected, not guessed.
 *
 *   node tools/review-india-boards.mjs            write data/india-boards-reviewed.yml and data/india-boards-rejected.tsv
 *   node tools/review-india-boards.mjs --apply    also insert the new entries into portals.yml (before the Job Boards section)
 *
 * Hosts already in portals.yml are skipped, so it is safe to re-run after the probe finishes.
 */
import { readFileSync, existsSync, writeFileSync, copyFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const JOBAPPLY = resolve(HERE, '..', '..');
const ROOT = process.env.CAREER_OPS_ROOT || join(JOBAPPLY, 'career-ops');
const DATA = join(ROOT, 'data');
const MARKER = '# ── Job Boards';

const LEGAL = /\b(private|pvt|limited|ltd|llp|inc|incorporated|corp|corporation|co|company|technologies|technology|tech|solutions|services|software|systems|labs|india|global|group|holdings|ventures|networks|digital|consulting|enterprises)\b/g;
export const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and');
const squash = (s) => norm(s).replace(/[^a-z0-9]/g, '');
const stripped = (s) => squash(norm(s).replace(LEGAL, ' '));

export const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };

/** Does the tenant label (first host label) plausibly belong to this company? */
export function labelMatches(company, url) {
  const label = squash(hostOf(url).split('.')[0]);
  const name = stripped(company) || squash(company);
  if (!label) return false;
  if (label === name && name.length >= 4) return true; // a short name is accepted only as an exact match
  if (name.length < 5) return false; // short or generic names collide with unrelated tenants
  return label === name || label === squash(company) || name.startsWith(label) && label.length >= 5 || label.startsWith(name);
}

const rows = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').slice(1).filter(Boolean).map((l) => l.split('\t')) : []);

export function review({ probeRows, directoryRows, directoryHosts, trackedHosts }) {
  const keep = new Map(); const rejected = [];
  const reject = (company, url, why) => rejected.push([company, url, why]);
  const put = (company, url, jobs, india, vendor) => {
    const h = hostOf(url);
    if (!h) return;
    if (trackedHosts.has(h)) return; // already scanned
    if (!keep.has(h)) keep.set(h, { company, url, jobs, india, vendor });
  };
  for (const [company, ats, url, , jobs, india, verdict] of directoryRows) {
    if (verdict !== 'ok') continue;
    if (!(Number(india) > 0)) { reject(company, url, 'no India roles'); continue; }
    put(company, url, jobs, india, ats);
  }
  for (const [company, vendor, url, jobs, india, confidence] of probeRows) {
    if (!(Number(jobs) > 0) || !(Number(india) > 0)) { reject(company, url, 'no India roles'); continue; }
    const fromDirectory = directoryHosts.get(hostOf(url));
    if (fromDirectory) { put(company, url, jobs, india, vendor); continue; }
    if (confidence !== 'high') { reject(company, url, 'low confidence'); continue; }
    if (!labelMatches(company, url)) { reject(company, url, 'tenant label does not match the company name'); continue; }
    put(company, url, jobs, india, vendor);
  }
  return { keep: [...keep.values()], rejected };
}

export function toYaml(boards) {
  const out = ['# Reviewed by tools/review-india-boards.mjs: postings found, India roles present, company name matches.', ''];
  for (const b of boards) {
    out.push(`- name: ${JSON.stringify(b.company)}`, `  careers_url: ${b.url}`, `  notes: ${JSON.stringify(`${b.vendor} board, ${b.jobs} jobs (${b.india} India), verified by tools/review-india-boards.mjs`)}`, '  enabled: true', '');
  }
  return out.join('\n');
}

function trackedHostsOf(portalsText) {
  const hosts = new Set();
  for (const l of portalsText.split('\n')) {
    if (/^\s*#/.test(l)) continue;
    const m = /https?:\/\/([a-z0-9.-]+)/i.exec(l);
    if (m) hosts.add(m[1].toLowerCase());
  }
  return hosts;
}

function main() {
  const apply = process.argv.includes('--apply');
  const portalsFile = join(ROOT, 'portals.yml');
  const portalsText = readFileSync(portalsFile, 'utf8');
  const directoryHosts = new Map();
  for (const l of (existsSync(join(DATA, 'careers-directory-hosts.txt')) ? readFileSync(join(DATA, 'careers-directory-hosts.txt'), 'utf8').split('\n') : [])) {
    const [h, c] = l.split('\t'); if (h && c) directoryHosts.set(h.trim().toLowerCase(), c.trim());
  }
  const { keep, rejected } = review({
    probeRows: rows(join(DATA, 'india-ats-boards.tsv')),
    directoryRows: rows(join(DATA, 'directory-boards.tsv')),
    directoryHosts,
    trackedHosts: trackedHostsOf(portalsText),
  });
  writeFileSync(join(DATA, 'india-boards-reviewed.yml'), toYaml(keep));
  writeFileSync(join(DATA, 'india-boards-rejected.tsv'), ['company\turl\twhy', ...rejected.map((r) => r.join('\t'))].join('\n') + '\n');
  console.log(`${keep.length} boards kept, ${rejected.length} rejected (see data/india-boards-rejected.tsv)`);
  if (!apply) return;
  if (!keep.length) { console.log('nothing new to add'); return; }
  copyFileSync(portalsFile, join(DATA, 'portals.yml.bak-before-india-boards')); // one rolling backup
  const at = portalsText.indexOf(MARKER);
  if (at < 0) throw new Error(`portals.yml has no "${MARKER}" section marker: nothing written`);
  const block = keep.map((b) => `  - name: ${JSON.stringify(b.company)}\n    careers_url: ${b.url}\n    notes: ${JSON.stringify(`${b.vendor} board, ${b.jobs} jobs (${b.india} India). Added by review-india-boards.`)}\n    enabled: true\n`).join('\n');
  writeFileSync(portalsFile, `${portalsText.slice(0, at)}  # -- Indian ATS boards (tools/review-india-boards.mjs) --\n${block}\n${portalsText.slice(at)}`);
  console.log(`added ${keep.length} entries to portals.yml`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
