#!/usr/bin/env node
/**
 * audit-board-identity.mjs: does each enabled board belong to the company it is named after?
 *
 *   node audit-board-identity.mjs              # all enabled boards, plus the protected list; writes the worklist
 *   node audit-board-identity.mjs --company NAME
 *   node audit-board-identity.mjs --json       # machine-readable result on stdout
 *   node audit-board-identity.mjs --no-write   # report only
 *
 * Checks, cheapest first, for every enabled board:
 *   owner     Greenhouse / Ashby / Lever publish the owner's name; a different name is a mismatch
 *   slug      the board slug should look like the company name
 *   domain    posting URLs on the employer's own domain should name the employer
 * Names in GENERIC_NAMES and in config/protected-boards.txt also need employer confirmation (the company's own
 * site links to the board, or the board is listed in data/identity-approved.tsv): a name match is not enough
 * ("Ghost", "Encore" and "Spiral" all matched by name and were other companies).
 *
 * It never enables or disables anything. Mismatches go to the `identity` section of data/check-by-hand.txt.
 */

import { isMainModule } from './lib/is-main-module.mjs';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { loadYaml } from './lib/yaml-document.mjs';
import { loadProviders, resolveProvider } from './providers/_registry.mjs';
import { makeHttpCtx } from './providers/_http.mjs';
import { ATS, parseAtsSlug, probeFetchJson, probeFetchText } from './verify-portals.mjs';
import { nameIdentityVerdict } from './lib/board-identity-names.mjs';
import { websiteConfirms, vendorSlug, loadApproved } from './lib/board-identity.mjs';
import { GENERIC_NAMES, postingDomainMismatch, slugMatchesName, parseAggregatorHosts, isAggregatorBoard } from './lib/board-audit.mjs';
import { loadProtected } from './board-india-check.mjs';
import { writeSection } from './lib/check-by-hand.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || join(getCareerOpsRoot(), 'portals.yml');
const CHECK_BY_HAND_PATH = process.env.CAREER_OPS_CHECK_BY_HAND || join(HERE, 'data', 'check-by-hand.txt');
const AGGREGATOR_PATH = process.env.CAREER_OPS_AGGREGATORS || join(getCareerOpsRoot(), 'data', 'aggregator-boards.tsv');
const APPROVED_PATH = process.env.CAREER_OPS_APPROVED || join(getCareerOpsRoot(), 'data', 'identity-approved.tsv');

const USAGE = `usage: audit-board-identity.mjs [--company NAME] [--json] [--no-write] [--concurrency N]
  Flags enabled boards whose owner name, slug or posting domains do not fit the company name.
  Names in GENERIC_NAMES and config/protected-boards.txt also need the company's own site to link to the board.
  Writes the findings to the identity section of data/check-by-hand.txt; never enables or disables anything.
  --help, -h   print this and exit`;

/** Judge one board. `fetchOwner(url, kind)` and `site(name, boardUrl)` are injected so tests need no network. */
export async function auditBoard({ entry, jobs, strict, approved, fetchOwner, site, aggregators = new Set() }) {
  const reasons = [];
  const name = entry.name;
  const url = entry.careers_url || entry.api || '';
  if (isAggregatorBoard(url, aggregators)) return { name, url, how: 'aggregator', reasons };
  const vs = vendorSlug(url);
  let how = null;
  if (vs && approved.has(`${vs.ats}|${vs.slug}`)) how = 'approved';

  const parsed = parseAtsSlug(url);
  if (parsed && ATS[parsed.ats]?.ownerUrl) {
    try {
      const spec = ATS[parsed.ats];
      const raw = await fetchOwner(spec.ownerUrl(parsed.slug, { eu: parsed.eu }), spec.ownerKind);
      const owner = spec.ownerName(raw);
      if (owner && !nameIdentityVerdict(name, owner).match && how !== 'approved') reasons.push(`owner is "${owner}"`);
    } catch { /* an unreachable owner page is not a mismatch */ }
  }
  if (vs && !slugMatchesName(vs.slug, name) && how !== 'approved') reasons.push(`slug "${vs.slug}" does not look like "${name}"`);
  const dom = postingDomainMismatch(name, (jobs || []).map((j) => j.url));
  if (dom.offBrand.length && how !== 'approved') reasons.push(`posting URLs on other domains: ${dom.offBrand.slice(0, 3).join(', ')}`);

  if (strict && how !== 'approved') {
    const s = await site(name, url);
    if (s.ok) how = 'website';
    else reasons.push('name alone is not enough for a generic or protected name, and the company site does not link to this board');
  }
  return { name, url, ats: vs?.ats, slug: vs?.slug, how, reasons };
}

async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const n = i++; await fn(items[n], n); } }));
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return; }
  const get = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const only = get('--company');
  const concurrency = Number(get('--concurrency')) || 3;
  if (!existsSync(PORTALS_PATH)) { console.error(`Error: ${PORTALS_PATH} not found.`); process.exit(1); }
  const cfg = loadYaml(readFileSync(PORTALS_PATH, 'utf-8')) || {};
  const protectedSet = loadProtected();
  const generic = new Set(GENERIC_NAMES.map((n) => n.toLowerCase()));
  const approved = loadApproved(APPROVED_PATH, { existsSync, readFileSync });
  const aggregators = parseAggregatorHosts(existsSync(AGGREGATOR_PATH) ? readFileSync(AGGREGATOR_PATH, 'utf-8') : '');
  const entries = (cfg.tracked_companies || []).filter((e) => e && typeof e.name === 'string' && e.enabled !== false)
    .filter((e) => !only || e.name.toLowerCase() === only.toLowerCase());
  const providers = await loadProviders(resolve(HERE, 'providers'));
  const ctx = makeHttpCtx();
  const results = new Array(entries.length);
  let done = 0;
  await pool(entries, concurrency, async (entry, idx) => {
    let jobs = [];
    const r = resolveProvider(entry, providers);
    if (r && !r.error) { try { jobs = await r.provider.fetch({ ...entry }, ctx); } catch { /* unreadable board: judged on name alone */ } }
    const strict = generic.has(entry.name.toLowerCase()) || protectedSet.has(entry.name.toLowerCase());
    const res = await auditBoard({
      entry, jobs, strict, approved, aggregators,
      fetchOwner: (u, kind) => (kind === 'html' ? probeFetchText(u, { maxBytes: 8192 }) : probeFetchJson(u)),
      site: (name, boardUrl) => websiteConfirms({ name, website: entry.website, boardUrl }, { fetchText: (u) => probeFetchText(u, { maxBytes: 400_000 }) }),
    });
    res.generic = generic.has(entry.name.toLowerCase());
    res.protected = protectedSet.has(entry.name.toLowerCase());
    res.total = jobs.length;
    res.samples = jobs.slice(0, 3).map((j) => `${j.title} [${j.location || '-'}]`);
    results[idx] = res;
    done++;
    console.error(`[${done}/${entries.length}] ${entry.name} ${res.reasons.length ? 'FLAG' : 'ok'}`);
  });

  const flagged = results.filter((r) => r.reasons.length)
    .sort((a, b) => Number(b.generic) - Number(a.generic) || Number(b.protected) - Number(a.protected) || a.name.localeCompare(b.name));
  if (argv.includes('--json')) console.log(JSON.stringify({ audited: results.length, flagged }, null, 1));
  else {
    console.log(`audited ${results.length} enabled boards: ${flagged.length} flagged (generic names first)`);
    for (const f of flagged) console.log(`- ${f.name}${f.generic ? ' [generic]' : ''}${f.protected ? ' [protected]' : ''} ${f.ats || ''}/${f.slug || ''} (${f.total} postings): ${f.reasons.join('; ')}\n    e.g. ${f.samples.join(' | ') || 'no postings read'}`);
  }
  if (!argv.includes('--no-write') && !only) {
    writeSection(CHECK_BY_HAND_PATH, 'identity', [
      '# Boards whose owner, slug or posting domains do not fit the company name. name<TAB>board<TAB>why. Not enabled or disabled by anything.',
      ...flagged.map((f) => `${f.name}\t${f.url}\t${f.reasons.join('; ')}`)]);
    console.log(`worklist: ${CHECK_BY_HAND_PATH} (identity section)`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => { console.error(err?.stack || err); process.exit(1); });
}
