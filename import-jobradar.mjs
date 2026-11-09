#!/usr/bin/env node

/**
 * import-jobradar.mjs: add the verified ATS boards from the sibling jobradar project
 * to portals.yml as enabled boards tagged `source: jobradar`.
 *
 *   node import-jobradar.mjs                 # preview: counts only, writes nothing
 *   node import-jobradar.mjs --list          # preview plus every entry that would be added
 *   node import-jobradar.mjs --write         # back up portals.yml, then add the new entries
 *
 * Input is jobradar/config/companies.csv (name, ats, slug, tier). A board is skipped
 * when portals.yml already has it, matched by name, by URL, or by the same ATS and slug
 * (so boards.greenhouse.io/x and job-boards.greenhouse.io/x count as one board).
 * portals.yml is a user-layer file: it is only written with --write, and never while a
 * discover-ats.mjs run is active, since that run also rewrites the file.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { loadYaml } from './lib/yaml-document.mjs';
import { renameSyncWithRetry } from './tracker-utils.mjs';
import {
  renderPortalEntry, dedupeAgainstPortals, insertIntoTrackedCompanies, splicedCorrectly,
} from './discover-ats.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || join(HERE, 'portals.yml');
const DEFAULT_CSV = resolve(HERE, '..', '..', 'jobradar', 'config', 'companies.csv');

const BOARDS = {
  greenhouse: {
    url: (s) => `https://job-boards.greenhouse.io/${s}`,
    api: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
  },
  ashby: { url: (s) => `https://jobs.ashbyhq.com/${s}` },
  lever: { url: (s) => `https://jobs.lever.co/${s}` },
  smartrecruiters: { url: (s) => `https://careers.smartrecruiters.com/${s}` },
};

const SLUG_PATTERNS = [
  ['greenhouse', /^https?:\/\/(?:job-boards|boards)\.greenhouse\.io\/([^/?#]+)/i],
  ['greenhouse', /^https?:\/\/boards-api\.greenhouse\.io\/v1\/boards\/([^/?#]+)/i],
  ['ashby', /^https?:\/\/jobs\.ashbyhq\.com\/([^/?#]+)/i],
  ['lever', /^https?:\/\/jobs\.lever\.co\/([^/?#]+)/i],
  ['lever', /^https?:\/\/api\.lever\.co\/v0\/postings\/([^/?#]+)/i],
  ['smartrecruiters', /^https?:\/\/careers\.smartrecruiters\.com\/([^/?#]+)/i],
  ['smartrecruiters', /^https?:\/\/api\.smartrecruiters\.com\/v1\/companies\/([^/?#]+)/i],
];

/** "greenhouse:stripe" for a URL on a known ATS host, else null. */
export function boardKey(url) {
  for (const [vendor, re] of SLUG_PATTERNS) {
    const m = String(url || '').trim().match(re);
    if (m) return `${vendor}:${m[1].toLowerCase()}`;
  }
  return null;
}

/** Parse jobradar's companies.csv: '#' lines are comments, first other line is the header. No quoting in this file. */
export function parseCompaniesCsv(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  const [header, ...rows] = lines;
  const cols = header.split(',').map((c) => c.trim());
  return rows.map((line) => {
    const cells = line.split(',').map((c) => c.trim());
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']));
  });
}

/** Turn csv rows into portal matches; rows on an unsupported ATS or with a bad slug are reported, not dropped silently. */
export function toMatches(rows) {
  const matches = [];
  const invalid = [];
  for (const r of rows) {
    const board = BOARDS[String(r.ats).toLowerCase()];
    const slug = String(r.slug || '').trim();
    if (!r.name || !board || !/^[A-Za-z0-9._-]+$/.test(slug)) {
      invalid.push({ name: r.name, ats: r.ats, slug, reason: !board ? 'unsupported ats' : 'bad name or slug' });
      continue;
    }
    matches.push({
      name: r.name,
      careers_url: board.url(slug),
      ...(board.api ? { api: board.api(slug) } : {}),
      tier: r.tier,
      key: `${String(r.ats).toLowerCase()}:${slug.toLowerCase()}`,
    });
  }
  return { matches, invalid };
}

/** Split matches into fresh and duplicates against existing portals entries and against each other. */
export function plan(matches, existingEntries) {
  const existingKeys = new Set();
  for (const e of existingEntries) {
    for (const u of [e?.careers_url, e?.api]) {
      const k = boardKey(u);
      if (k) existingKeys.add(k);
    }
  }
  const byKey = [];
  const keyDuplicates = [];
  const seen = new Set();
  for (const m of matches) {
    if (existingKeys.has(m.key) || seen.has(m.key)) keyDuplicates.push(m);
    else { seen.add(m.key); byKey.push(m); }
  }
  const { fresh, duplicates } = dedupeAgainstPortals(byKey, existingEntries);
  return { fresh, duplicates: [...keyDuplicates, ...duplicates] };
}

/** Rendered entry with the source tag placed right after `enabled: true`. */
export function renderTagged(match) {
  return renderPortalEntry(match).replace('    enabled: true\n', '    enabled: true\n    source: jobradar\n');
}

function discoverIsRunning() {
  try {
    const out = execFileSync('pgrep', ['-fl', 'discover-ats.mjs'], { encoding: 'utf8' });
    return out.split('\n').filter((l) => l && !l.includes('pgrep')).length > 0;
  } catch {
    return false; // pgrep exits 1 when nothing matches
  }
}

function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const list = args.includes('--list');
  const force = args.includes('--force');
  const csvFlag = args.indexOf('--csv');
  const csvPath = csvFlag >= 0 ? resolve(args[csvFlag + 1]) : DEFAULT_CSV;

  if (!existsSync(csvPath)) { console.error(`Error: ${csvPath} not found. Pass --csv PATH.`); process.exit(1); }
  if (!existsSync(PORTALS_PATH)) { console.error(`Error: ${PORTALS_PATH} not found.`); process.exit(1); }

  const rows = parseCompaniesCsv(readFileSync(csvPath, 'utf-8'));
  const { matches, invalid } = toMatches(rows);
  const portalsText = readFileSync(PORTALS_PATH, 'utf-8');
  const existing = (loadYaml(portalsText) || {}).tracked_companies || [];
  const { fresh, duplicates } = plan(matches, existing);

  console.log(`jobradar rows read:      ${rows.length}`);
  console.log(`unusable (skipped):      ${invalid.length}`);
  console.log(`already in portals.yml:  ${duplicates.length} (or repeated inside jobradar)`);
  console.log(`new boards to add:       ${fresh.length}`);
  console.log(`portals.yml entries now: ${existing.length}`);
  for (const i of invalid) console.log(`  unusable: ${i.name} (${i.ats}/${i.slug}): ${i.reason}`);
  if (list) for (const f of fresh) console.log(`  + ${f.name}  ${f.careers_url}`);

  if (!write) { console.log('\nPreview only. Run with --write to add them.'); return; }
  if (!fresh.length) { console.log('\nNothing to add.'); return; }
  if (!force && discoverIsRunning()) {
    console.error('\nRefusing to write: a discover-ats.mjs run is active and also rewrites portals.yml. Wait for it to finish, or pass --force.');
    process.exit(2);
  }

  const backup = `${PORTALS_PATH}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(PORTALS_PATH, backup);

  const next = insertIntoTrackedCompanies(portalsText, fresh.map(renderTagged));
  if (!splicedCorrectly(next, existing.length + fresh.length)) {
    console.error(`\nSplice check failed; portals.yml left unchanged. Backup is at ${backup}.`);
    process.exit(3);
  }
  const tmp = `${PORTALS_PATH}.tmp-${process.pid}`;
  writeFileSync(tmp, next, 'utf-8');
  renameSyncWithRetry(tmp, PORTALS_PATH);
  console.log(`\nAdded ${fresh.length} boards. Backup: ${backup}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
