// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { fetchJsonWithRetry, sleep } from './_http.mjs';
import { coerceId } from './_ids.mjs';

// Instahyre provider: India's curated tech-hiring board. Reads the public JSON that instahyre.com's own search page
// calls, with no login and no key (robots.txt disallows nothing):
//
//   GET https://www.instahyre.com/api/v1/job_search?years=<n>&skills=<word>&limit=35&offset=<n>
//   -> { objects: [ {id, title, locations: "Bangalore,Hyderabad", public_url, employer:{company_name,...}, keywords:[...]} ],
//        meta: { total_count, next, limit, offset } }
//
// Measured 2026-11-10: `years=0` is the fresher/intern feed (836 of 19,658 jobs; internships carry 0 years), `skills=` filters
// by skill tag, and rows come in Instahyre's own score order. The `location` parameter is NOT honoured by the endpoint (the
// total never changes), so places are filtered here and by the portals location_filter.
// Dates: Instahyre's search carries none and its HTML pages sit behind Cloudflare, so postedAt is left off. Job ids rise as
// jobs are posted, so rows are returned highest id first (newest first).
//
// A job board / aggregator, not a company ATS: use `provider: instahyre`. Rows are UNCONFIRMED until found at the employer
// (AGENTS.md "Aggregator Listings"); instahyre.com is in config/pipeline.yml aggregator_hosts.
//
// Entry fields (all optional):
//   years      candidate experience in years, default 0 (fresher/intern). Use "any" for no experience filter.
//   skills     one skill tag, e.g. "python" (empty = no skill filter)
//   cities     list of city names to keep, e.g. [Delhi, Gurgaon, Noida]; "NCR" expands to the Delhi NCR cities. Empty = keep all.
//   maxPages   default 25, hard ceiling 60 (35 rows a page)

const ENDPOINT = 'https://www.instahyre.com/api/v1/job_search';
const PAGE_SIZE = 35;
const DEFAULT_MAX_PAGES = 25;
const MAX_PAGES_CAP = 60;
const PAGE_DELAY_MS = 1500; // Instahyre limits roughly 20 searches a minute per address
const NCR = ['delhi', 'new delhi', 'gurgaon', 'gurugram', 'noida', 'greater noida', 'faridabad', 'ghaziabad'];

/** @param {any} entry */
export function resolveOptions(entry) {
  const y = entry?.years;
  const years = y === 'any' || y === null ? null : Number.isInteger(Number(y ?? 0)) && Number(y ?? 0) >= 0 && Number(y ?? 0) <= 30 ? Number(y ?? 0) : 0;
  const skills = typeof entry?.skills === 'string' ? entry.skills.trim().toLowerCase().replace(/[^a-z0-9+#. -]/g, '') : '';
  const raw = Array.isArray(entry?.cities) ? entry.cities.map((c) => String(c).trim().toLowerCase()).filter(Boolean) : [];
  const cities = raw.flatMap((c) => (c === 'ncr' || c === 'delhi ncr' ? NCR : [c]));
  const mp = Number(entry?.maxPages ?? entry?.max_pages);
  const maxPages = Number.isInteger(mp) && mp > 0 ? Math.min(mp, MAX_PAGES_CAP) : DEFAULT_MAX_PAGES;
  return { years, skills, cities, maxPages };
}

const str = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/** City list of a row ("Bangalore,Hyderabad" -> ["Bangalore","Hyderabad"]). */
export const cityList = (row) => str(row?.locations).split(',').map((c) => c.trim()).filter(Boolean);

/**
 * Parse one page. The envelope must be { objects: [], meta: {} }; anything else throws so a changed API does not read as
 * "no jobs" forever. A malformed row is dropped alone.
 * @param {any} json
 * @param {string[]} cities  lower-case city filter (empty = keep all)
 * @returns {{ jobs: import('./_types.js').Job[], next: boolean, total: number }}
 */
export function parseInstahyrePage(json, cities = []) {
  if (!json || !Array.isArray(json.objects) || typeof json.meta !== 'object' || json.meta === null) {
    const got = json && typeof json === 'object' ? Object.keys(json).join(', ') : typeof json;
    throw new Error(`instahyre: unexpected response, expected {objects, meta}, got: [${got}]`);
  }
  const jobs = [];
  for (const row of json.objects) {
    if (!row || typeof row !== 'object') continue;
    const id = coerceId(row.id);
    const title = str(row.title) || str(row.candidate_title);
    const url = str(row.public_url);
    if (id === undefined || !title || !/^https:\/\/www\.instahyre\.com\//.test(url)) continue;
    const places = cityList(row);
    if (cities.length && !places.some((p) => cities.includes(p.toLowerCase()))) continue;
    /** @type {import('./_types.js').Job} */
    const job = { title, url, company: str(row.employer?.company_name), location: places.join('; ') || 'India', externalId: String(id) };
    if (Array.isArray(row.keywords) && row.keywords.length) job.description = `Skills: ${row.keywords.filter((k) => typeof k === 'string').slice(0, 20).join(', ')}`;
    jobs.push(job);
  }
  return { jobs, next: typeof json.meta.next === 'string' && json.meta.next.length > 0 && json.objects.length > 0, total: Number(json.meta.total_count) || 0 };
}

/** @type {Provider} */
export default {
  id: 'instahyre',
  detect(_entry) { return null; },
  async fetch(entry, ctx) {
    const { years, skills, cities, maxPages } = resolveOptions(entry);
    const probing = Number(ctx?.maxPages) > 0;
    const pages = probing ? Math.min(maxPages, Number(ctx.maxPages)) : maxPages;
    const out = []; const seen = new Set();
    for (let page = 0; page < pages; page++) {
      if (page > 0) await sleep(PAGE_DELAY_MS, ctx);
      const q = new URLSearchParams();
      if (years !== null) q.set('years', String(years));
      if (skills) q.set('skills', skills);
      q.set('limit', String(PAGE_SIZE)); q.set('offset', String(page * PAGE_SIZE));
      let parsed;
      try { parsed = parseInstahyrePage(await fetchJsonWithRetry(ctx, `${ENDPOINT}?${q}`, { redirect: 'error' }), cities); }
      catch (err) {
        if (probing || page === 0) throw err;
        console.error(`instahyre: stopped at page ${page + 1} (${out.length} so far): ${err instanceof Error ? err.message : err}`);
        break;
      }
      for (const j of parsed.jobs) if (!seen.has(j.url)) { seen.add(j.url); out.push(j); }
      if (!parsed.next) break;
    }
    return out.sort((a, b) => Number(b.externalId) - Number(a.externalId)); // newest first: ids rise with posting time
  },
};
