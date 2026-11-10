// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { fetchJsonWithRetry, sleep } from './_http.mjs';
import { htmlToText } from './_html-to-text.mjs';
import { coerceId } from './_ids.mjs';

// Unstop provider: India's campus and early-career board (jobs and internships).
// Public, no-auth JSON behind the site's own search page:
//
//   GET https://unstop.com/api/public/opportunity/search-result
//       ?opportunity=jobs|internships&oppstatus=open&per_page=<n>&page=<n>
//   -> { data: { current_page, last_page, total, data: [ {id, title, seo_url, organisation:{name},
//        locations:[{city,state,country}], jobDetail:{type, locations, min_experience...}, details (HTML),
//        approved_date, end_date, ...} ] } }
//
// A job board, not a company ATS, so there is no detect(): use `provider: unstop` explicitly.
//
// Portal entry fields (all optional):
//   opportunity  'jobs' (default) or 'internships'
//   maxPages     page cap, default 30, hard ceiling 100 (100 rows a page)
//   searchKeywords  free-text filter forwarded as `searchTerm`
//
// The host is fixed to unstop.com; an `api:` override is not honoured.

const ENDPOINT = 'https://unstop.com/api/public/opportunity/search-result';
const PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 30;
const MAX_PAGES_CAP = 100;
const INTER_PAGE_DELAY_MS = 300;
const KINDS = new Set(['jobs', 'internships']);

/** @param {any} entry @returns {'jobs'|'internships'} */
export function resolveKind(entry) {
  const k = typeof entry?.opportunity === 'string' ? entry.opportunity.trim().toLowerCase() : 'jobs';
  return KINDS.has(k) ? /** @type {any} */ (k) : 'jobs';
}

/** @param {any} entry */
export function resolveMaxPages(entry) {
  const v = Number(entry?.maxPages ?? entry?.max_pages);
  return Number.isInteger(v) && v > 0 ? Math.min(v, MAX_PAGES_CAP) : DEFAULT_MAX_PAGES;
}

const str = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/**
 * "City, State" per location, joined with "; ". Falls back to the job-detail city list, then "Remote" for a
 * work-from-home posting. A posting with no place at all gets "India": Unstop lists the Indian market, and an
 * empty location would let the scanner's location filter drop it silently.
 * @param {any} row
 */
export function jobLocation(row) {
  const parts = [];
  const add = (p) => { if (p && !parts.includes(p)) parts.push(p); };
  for (const loc of Array.isArray(row?.locations) ? row.locations : []) {
    if (!loc || typeof loc !== 'object') continue;
    add([str(loc.city), str(loc.state), str(loc.country)].filter(Boolean).join(', '));
  }
  if (!parts.length) for (const c of Array.isArray(row?.jobDetail?.locations) ? row.jobDetail.locations : []) add(str(c));
  const wfh = row?.jobDetail?.type === 'wfh';
  if (wfh) add('Remote');
  if (!parts.length) add('India');
  return parts.join('; ');
}

/** @param {any} v @returns {number | undefined} */
function toEpochMs(v) {
  if (typeof v !== 'string' || !v) return undefined;
  // "2026-11-10 09:20:24 GMT+0530" is not ISO: rewrite it as one.
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) GMT([+-]\d{2})(\d{2})$/.exec(v.trim());
  const t = Date.parse(m ? `${m[1]}T${m[2]}${m[3]}:${m[4]}` : v);
  return Number.isNaN(t) ? undefined : t;
}

/**
 * Parse one page. Exported for tests. The envelope must be { data: { data: [] } }; anything else throws so a
 * silent API change does not read as zero postings forever. A malformed row is dropped alone. Closed rows are dropped.
 * @param {any} json
 * @param {string} fallbackCompany
 * @returns {{ jobs: import('./_types.js').Job[], lastPage: number }}
 */
export function parseUnstopPage(json, fallbackCompany = '') {
  const page = json?.data;
  if (!page || !Array.isArray(page.data)) {
    const got = json && typeof json === 'object' ? Object.keys(json).join(', ') : typeof json;
    throw new Error(`unstop: unexpected response, expected data.data array, got: [${got}]`);
  }
  const jobs = [];
  for (const row of page.data) {
    if (!row || typeof row !== 'object') continue;
    if (row.status && row.status !== 'LIVE') continue;
    if (row.regn_open === 0) continue;
    const title = str(row.title);
    const id = coerceId(row.id);
    let url = typeof row.seo_url === 'string' ? row.seo_url.trim() : '';
    if (!url && typeof row.public_url === 'string' && row.public_url) url = `https://unstop.com/${row.public_url.replace(/^\/+/, '')}`;
    if (!title || id === undefined || !/^https:\/\/unstop\.com\//.test(url)) continue;
    /** @type {import('./_types.js').Job} */
    const job = { title, url, company: str(row.organisation?.name) || fallbackCompany, location: jobLocation(row), externalId: String(id) };
    const postedAt = toEpochMs(row.approved_date) ?? toEpochMs(row.updated_at);
    if (postedAt !== undefined) job.postedAt = postedAt;
    const description = htmlToText(row.details);
    if (description) job.description = description;
    jobs.push(job);
  }
  const last = Number(page.last_page);
  return { jobs, lastPage: Number.isFinite(last) && last > 0 ? last : 1 };
}

/** @type {Provider} */
export default {
  id: 'unstop',

  detect(_entry) {
    return null; // a board, not a company ATS: set `provider: unstop`
  },

  async fetch(entry, ctx) {
    const kind = resolveKind(entry);
    const maxPages = resolveMaxPages(entry);
    const probing = Number(ctx?.maxPages) > 0;
    const pages = probing ? Math.min(maxPages, Number(ctx.maxPages)) : maxPages;
    const term = str(entry?.searchKeywords);
    const out = [];
    const seen = new Set();
    for (let page = 1; page <= pages; page++) {
      if (page > 1) await sleep(INTER_PAGE_DELAY_MS, ctx);
      const q = new URLSearchParams({ opportunity: kind, oppstatus: 'open', per_page: String(PER_PAGE), page: String(page) });
      if (term) q.set('searchTerm', term);
      let parsed;
      try {
        parsed = parseUnstopPage(await fetchJsonWithRetry(ctx, `${ENDPOINT}?${q}`, { redirect: 'error' }), str(entry?.name));
      } catch (err) {
        if (probing || page === 1) throw err; // first page failing means broken, not empty
        console.error(`unstop: ${kind} stopped at page ${page} (${out.length} so far): ${err instanceof Error ? err.message : err}`);
        break;
      }
      for (const j of parsed.jobs) if (!seen.has(j.url)) { seen.add(j.url); out.push(j); }
      if (page >= parsed.lastPage) break;
    }
    return out;
  },
};
