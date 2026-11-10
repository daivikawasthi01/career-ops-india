// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { fetchTextWithRetry, sleep } from './_http.mjs';

// Y Combinator jobs board (ycombinator.com/jobs). Many YC startups in India post only here.
// The listing pages are server rendered with an Inertia payload in the `data-page` attribute:
//   props.jobPostings = [ {id, title, url, location, type, minExperience, companyName, companyBatchName, createdAt, ...} ]
// A board, not a company ATS: use `provider: yc`.
//
// Portal entry fields (all optional):
//   roles      role slugs, default ['software-engineer']
//   places     'india' | 'remote' | '' (any), default ['india', 'remote']

const ORIGIN = 'https://www.ycombinator.com';
const DEFAULT_ROLES = ['software-engineer'];
const DEFAULT_PLACES = ['india', 'remote'];
const SLUG = /^[a-z0-9-]{1,40}$/;

const list = (v, d) => {
  const ok = Array.isArray(v) ? v.map((x) => String(x).trim().toLowerCase()).filter((x) => x === '' || SLUG.test(x)) : [];
  return ok.length ? ok : d; // nothing valid configured: use the defaults, never an empty search
};

/** @param {any} entry @returns {string[]} listing page URLs */
export function listingUrls(entry) {
  const roles = list(entry?.roles, DEFAULT_ROLES).filter(Boolean);
  const places = list(entry?.places, DEFAULT_PLACES);
  const urls = [];
  for (const r of roles) for (const p of places) urls.push(`${ORIGIN}/jobs/role/${r}${p ? `/${p}` : ''}`);
  return urls;
}

const unescapeAttr = (s) => s.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** "3 days", "about 1 month", "2 hours" -> epoch ms (approximate), or undefined. */
export function agoToMs(text, now = Date.now()) {
  const m = /(\d+|an?|one)\s*(minute|hour|day|week|month|year)s?/i.exec(String(text || ''));
  if (!m) return undefined;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : 1;
  const unit = { minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 }[m[2].toLowerCase()];
  return now - n * unit;
}

/**
 * Parse one listing page. Throws when the Inertia payload or its jobPostings array is missing, so a layout change
 * does not read as zero postings forever. A malformed row is dropped alone.
 * @param {string} html
 * @returns {import('./_types.js').Job[]}
 */
export function parseListing(html) {
  const m = /data-page="([^"]+)"/.exec(html || '');
  if (!m) throw new Error('yc: no data-page payload on the listing page (blocked, or the layout changed)');
  let data;
  try { data = JSON.parse(unescapeAttr(m[1])); } catch { throw new Error('yc: data-page payload is not valid JSON'); }
  const rows = data?.props?.jobPostings;
  if (!Array.isArray(rows)) throw new Error(`yc: expected props.jobPostings array, got [${Object.keys(data?.props || {}).slice(0, 8).join(', ')}]`);
  const jobs = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const rel = typeof r.url === 'string' ? r.url : '';
    const title = typeof r.title === 'string' ? r.title.replace(/\s+/g, ' ').trim() : '';
    if (!title || !/^\/companies\/[^/]+\/jobs\//.test(rel)) continue;
    /** @type {import('./_types.js').Job} */
    const job = { title, url: `${ORIGIN}${rel}`, company: String(r.companyName || '').trim(), location: String(r.location || '').trim() || 'Remote', externalId: String(r.id ?? rel) };
    const at = agoToMs(r.createdAt);
    if (at !== undefined) job.postedAt = at;
    const extras = [r.type, r.minExperience && `exp ${r.minExperience}`, r.visa, r.companyBatchName && `YC ${r.companyBatchName}`, r.companyOneLiner].filter(Boolean).join(' | ');
    if (extras) job.description = extras;
    jobs.push(job);
  }
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'yc',
  detect(_entry) { return null; },
  async fetch(entry, ctx) {
    const urls = listingUrls(entry);
    const probing = Number(ctx?.maxPages) > 0;
    const out = []; const seen = new Set();
    for (const [i, url] of urls.slice(0, probing ? 1 : undefined).entries()) {
      if (i > 0) await sleep(500, ctx);
      let jobs;
      try { jobs = parseListing(await fetchTextWithRetry(ctx, url, { redirect: 'follow' })); }
      catch (err) { if (i === 0 || probing) throw err; console.error(`yc: ${url} skipped: ${err instanceof Error ? err.message : err}`); continue; }
      for (const j of jobs) if (!seen.has(j.url)) { seen.add(j.url); out.push(j); }
    }
    return out;
  },
};
