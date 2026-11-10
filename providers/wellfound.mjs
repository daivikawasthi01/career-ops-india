// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { sleep } from './_http.mjs';

// Wellfound provider: startup jobs. The public role pages (https://wellfound.com/role/l/<role>/india, ?page=N) are
// server-rendered and carry an Apollo cache in __NEXT_DATA__ with about 30-36 JobListingSearchResult rows a page
// (title, yearsExperienceMin/Max, liveStartAt, locationNames, remote flag) linked to a StartupResult (company name, slug).
//
// Not used: wellfound.com/graphql. It needs a logged-in session, a signed X-Apollo-Signature and DataDome cookies, and
// answers 403 "Security Check" without them (measured 2026-11-10). Reading like a visitor means the role pages only.
//
// Wellfound bot-checks heavy traffic, so the budget is small: roles x pages requests, ROLE_DELAY_MS apart. A block page
// (no __NEXT_DATA__, or the "Security Check" title) ends the run at once rather than retrying, and fails loudly when no
// page was read yet. Role slugs that Wellfound redirects (303) read as an error and are skipped with a note.
//
// A job board, not a company ATS: use `provider: wellfound`. Rows are UNCONFIRMED until found at the employer
// (AGENTS.md "Aggregator Listings"); wellfound.com is in config/pipeline.yml aggregator_hosts.
//
// Entry fields (all optional):
//   roles       role slugs, default DEFAULT_ROLES
//   pages       pages per role, default 2, ceiling 5
//   maxYears    drop listings whose minimum experience is above this (default 2); listings with no figure are kept

const BASE = 'https://wellfound.com';
const DEFAULT_ROLES = ['software-engineer', 'backend-engineer', 'frontend-engineer', 'full-stack-engineer', 'devops-engineer', 'machine-learning-engineer'];
const DEFAULT_PAGES = 2;
const MAX_PAGES_CAP = 5;
const ROLE_DELAY_MS = 8000;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;

/** @param {any} entry */
export function resolveOptions(entry) {
  const roles = (Array.isArray(entry?.roles) ? entry.roles : DEFAULT_ROLES).map((r) => String(r).trim().toLowerCase()).filter((r) => SLUG_RE.test(r));
  const p = Number(entry?.pages);
  const y = entry?.maxYears;
  return {
    roles: roles.length ? [...new Set(roles)] : DEFAULT_ROLES,
    pages: Number.isInteger(p) && p > 0 ? Math.min(p, MAX_PAGES_CAP) : DEFAULT_PAGES,
    maxYears: Number.isInteger(y) && y >= 0 && y <= 30 ? y : 2,
  };
}

export const roleUrl = (role, page) => `${BASE}/role/l/${role}/india${page > 1 ? `?page=${page}` : ''}`;

/** The Apollo cache of a role page. Throws on a block page or a changed layout so it never reads as "no jobs". */
export function extractApollo(html) {
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? '';
  if (/security check/i.test(title)) throw new Error('wellfound: blocked by the bot check (Security Check page)');
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('wellfound: page has no __NEXT_DATA__ (layout changed or blocked)');
  const props = JSON.parse(m[1])?.props?.pageProps;
  const state = props?.apolloState;
  const data = state?.data ?? state;
  if (!data || typeof data !== 'object') throw new Error('wellfound: no apolloState in __NEXT_DATA__ (layout changed)');
  return data;
}

const str = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/**
 * Apollo cache -> jobs. A malformed listing is dropped alone.
 * @returns {import('./_types.js').Job[]}
 */
export function parseListings(data, { maxYears = 2 } = {}) {
  const company = new Map(); // listing key -> company name
  for (const [k, v] of Object.entries(data)) {
    if (!k.startsWith('StartupResult') || !v || typeof v !== 'object') continue;
    for (const ref of v.highlightedJobListings ?? []) if (ref?.__ref) company.set(ref.__ref, str(v.name));
  }
  const jobs = [];
  for (const [k, v] of Object.entries(data)) {
    if (!k.startsWith('JobListingSearchResult') || !v || typeof v !== 'object') continue;
    const id = str(String(v.id ?? ''));
    const title = str(v.title);
    const slug = str(v.slug);
    if (!/^\d+$/.test(id) || !title || !SLUG_RE.test(slug)) continue;
    if (typeof v.yearsExperienceMin === 'number' && v.yearsExperienceMin > maxYears) continue;
    const places = [...new Set((v.locationNames ?? []).map(str).filter(Boolean))];
    /** @type {import('./_types.js').Job} */
    const job = { title, url: `${BASE}/jobs/${id}-${slug}`, company: company.get(k) ?? '', location: places.join('; ') || (v.remote ? 'Remote' : 'India'), externalId: id };
    if (typeof v.liveStartAt === 'number' && v.liveStartAt > 0) job.postedAt = v.liveStartAt * 1000;
    const bits = [str(v.compensation), typeof v.yearsExperienceMin === 'number' ? `Experience: ${v.yearsExperienceMin}+ years` : '', str(v.jobType)].filter(Boolean);
    if (bits.length) job.description = bits.join('. ');
    jobs.push(job);
  }
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'wellfound',
  detect(_entry) { return null; },
  async fetch(entry, ctx) {
    const { roles, pages, maxYears } = resolveOptions(entry);
    const probing = Number(ctx?.maxPages) > 0;
    const pageCap = probing ? Math.min(pages, Number(ctx.maxPages)) : pages;
    const out = []; const seen = new Set(); let read = 0;
    for (const role of probing ? roles.slice(0, 1) : roles) {
      for (let page = 1; page <= pageCap; page++) {
        if (read > 0) await sleep(ROLE_DELAY_MS, ctx);
        let data;
        try { data = extractApollo(await ctx.fetchText(roleUrl(role, page), { redirect: 'error' })); }
        catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/bot check|__NEXT_DATA__|apolloState/.test(msg)) {
            if (!read) throw err; // nothing read yet: fail loudly
            console.error(`wellfound: stopped at ${role} page ${page} (${out.length} jobs so far): ${msg}`);
            return out.sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0));
          }
          console.error(`wellfound: skipped ${role} page ${page}: ${msg}`); // a redirected or missing role slug
          break;
        }
        read++;
        const rows = parseListings(data, { maxYears });
        for (const j of rows) if (!seen.has(j.url)) { seen.add(j.url); out.push(j); }
        if (!rows.length) break;
      }
    }
    if (!read) throw new Error('wellfound: no role page could be read');
    return out.sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0));
  },
};
