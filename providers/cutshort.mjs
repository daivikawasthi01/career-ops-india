// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { sleep } from './_http.mjs';
import { htmlToText } from './_html-to-text.mjs';

// Cutshort provider: India's startup tech-hiring board. Cutshort's search pages are client-rendered (no data in the HTML),
// so this reads the two things any visitor's crawler can read:
//
//   1. https://cutshort.io/sitemap_jobs.xml   ~45,000 job URLs, NEWEST POSTED FIRST (measured 2026-11-10: entry 0 is today, entry
//                                             1100 is 31 days old; <lastmod> is a refresh time and says nothing about age)
//   2. each https://cutshort.io/job/<slug>    carries a schema.org JobPosting (title, company, city, datePosted,
//                                             experienceRequirements.monthsOfExperience, baseSalary)
//
// robots.txt disallows /view/j/, /apply/ and ?ref= style URLs, not /job/ or the sitemap, and states no Crawl-delay.
// The slug carries title, city and company, so it is filtered BEFORE any page is fetched: senior/lead/non-tech slugs are
// dropped. Pages are read in sitemap order (one every PAGE_DELAY_MS) until OLD_STREAK_STOP in a row are older than
// `sinceDays`, which the ordering makes the end of the recent part, or `maxFetch` pages are read.
// Pages that fail the experience test are remembered in ctx.idCache so a later run does not fetch them again.
//
// A job board, not a company ATS: use `provider: cutshort`. Rows are UNCONFIRMED until found at the employer
// (AGENTS.md "Aggregator Listings"); cutshort.io is in config/pipeline.yml aggregator_hosts.
//
// Entry fields (all optional):
//   sinceDays          keep jobs posted within this many days (default 14)
//   maxExperienceMonths  keep jobs asking for at most this many months (default 12); a page with no figure is kept
//   maxFetch           job pages fetched per run (default 300, ceiling 600); a 14-day window is about 200 pages
//   include / exclude  extra slug words to allow / drop (lower-case, hyphen-free words)

const SITEMAP = 'https://cutshort.io/sitemap_jobs.xml';
const SITEMAP_MAX_BYTES = 30 * 1024 * 1024;
const JOB_URL_RE = /^https:\/\/cutshort\.io\/job\/[A-Za-z0-9_-]+$/;
const PAGE_DELAY_MS = 1500;
const DEFAULT_MAX_FETCH = 300;
const MAX_FETCH_CAP = 600;
const FAIL_STREAK_STOP = 5; // consecutive page failures that end the run (blocked or down)
const OLD_STREAK_STOP = 3; // consecutive too-old pages that end the run (the sitemap is newest first)
const REJECT_KEEP_MS = 30 * 864e5;

const TECH = ['software', 'developer', 'engineer', 'sde', 'sdet', 'devops', 'backend', 'frontend', 'fullstack', 'full', 'stack', 'python', 'java',
  'golang', 'react', 'node', 'nodejs', 'data', 'ml', 'machine', 'learning', 'ai', 'qa', 'programmer', 'intern', 'trainee', 'fresher', 'cloud', 'sre', 'android', 'ios'];
const SKIP = ['senior', 'sr', 'lead', 'principal', 'staff', 'manager', 'head', 'architect', 'director', 'vp', 'sales', 'marketing', 'recruiter', 'hr',
  'accountant', 'consultant', 'specialist', 'executive', 'tech-lead'];

/** @param {any} entry */
export function resolveOptions(entry) {
  const int = (v, lo, hi, d) => (Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi && v !== null && v !== '' && v !== undefined ? Number(v) : d);
  const words = (v) => (Array.isArray(v) ? v.map((w) => String(w).toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean) : []);
  return {
    sinceDays: int(entry?.sinceDays, 1, 365, 14),
    maxExperienceMonths: int(entry?.maxExperienceMonths, 0, 600, 12),
    maxFetch: int(entry?.maxFetch, 1, MAX_FETCH_CAP, DEFAULT_MAX_FETCH),
    include: words(entry?.include),
    exclude: words(entry?.exclude),
  };
}

/** Sitemap XML -> [{url, lastmod(ms)}]. Throws when it holds no <loc>, so a changed format is not read as "no jobs". */
export function parseSitemap(xml) {
  if (typeof xml !== 'string' || !xml.includes('<urlset')) throw new Error('cutshort: sitemap_jobs.xml is not a urlset');
  const out = [];
  for (const m of xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>(?:\s*<lastmod>([^<]+)<\/lastmod>)?/g)) {
    const url = m[1].trim();
    if (!JOB_URL_RE.test(url)) continue;
    const lastmod = Date.parse(m[2] ?? '');
    out.push({ url, lastmod: Number.isFinite(lastmod) ? lastmod : 0 });
  }
  if (!out.length) throw new Error('cutshort: sitemap_jobs.xml has no job URLs');
  return out;
}

/** Words of a job slug: ".../job/Senior-Net-Developer-Pune-Acme-1Qj1Uhll" -> ["senior","net","developer",...]. */
const slugWords = (url) => url.split('/job/')[1].split('-').slice(0, -1).map((w) => w.toLowerCase()).filter(Boolean);

/** @returns {{keep: boolean}} */
export function judgeSlug(url, { include = [], exclude = [] } = {}) {
  const words = slugWords(url);
  if (words.some((w) => SKIP.includes(w) || exclude.includes(w))) return { keep: false };
  return { keep: words.some((w) => TECH.includes(w) || include.includes(w)) };
}

/** The JobPosting object of a job page, or null. Other ld+json blocks (WebPage, BreadcrumbList) are ignored. */
export function extractJobPosting(html) {
  for (const m of String(html).matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1]);
      for (const node of Array.isArray(j) ? j : [j]) if (node?.['@type'] === 'JobPosting') return node;
    } catch { /* a malformed block is skipped; the page still fails loudly below if none parse */ }
  }
  return null;
}

const str = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/**
 * JobPosting -> Job, or {reject} when it fails the test (reason only for the cache).
 * @returns {{job: import('./_types.js').Job} | {reject: string}}
 */
export function toJob(url, posting, { maxExperienceMonths, sinceDays }, now = Date.now()) {
  const title = str(posting.title);
  if (!title) return { reject: 'no-title' };
  const posted = Date.parse(posting.datePosted ?? '');
  if (Number.isFinite(posted) && now - posted > sinceDays * 864e5) return { reject: 'old' };
  const months = posting.experienceRequirements?.monthsOfExperience;
  if (typeof months === 'number' && months > maxExperienceMonths) return { reject: 'experienced' };
  const place = Array.isArray(posting.jobLocation) ? posting.jobLocation[0] : posting.jobLocation;
  const addr = place?.address ?? {};
  if (str(addr.addressCountry) && str(addr.addressCountry).toUpperCase() !== 'IN') return { reject: 'abroad' };
  /** @type {import('./_types.js').Job} */
  const job = { title, url, company: str(posting.hiringOrganization?.name), location: str(addr.addressLocality) || 'India', externalId: url.split('-').pop() };
  if (Number.isFinite(posted)) job.postedAt = posted;
  const text = htmlToText(String(posting.description ?? ''), { cap: 1500 });
  if (text) job.description = typeof months === 'number' ? `Experience: ${months} months. ${text}` : text;
  const v = posting.baseSalary?.value;
  if (v && typeof v.minValue === 'number' && typeof v.maxValue === 'number' && posting.baseSalary.currency === 'INR') job.salary = { min: v.minValue, max: v.maxValue, currency: 'INR' };
  return { job };
}

/** @type {Provider} */
export default {
  id: 'cutshort',
  detect(_entry) { return null; },
  async fetch(entry, ctx) {
    const opts = resolveOptions(entry);
    const now = Date.now();
    const probing = Number(ctx?.maxPages) > 0;
    const budget = probing ? Math.min(opts.maxFetch, Number(ctx.maxPages) * 10) : opts.maxFetch;

    const rows = parseSitemap(await ctx.fetchText(SITEMAP, { redirect: 'follow', maxBytes: SITEMAP_MAX_BYTES }));
    const queue = rows
      .filter((r) => judgeSlug(r.url, opts).keep)
      .filter((r) => {
        const c = ctx.idCache?.get(`cutshort:${r.url}`);
        return !(c && Date.now() - Date.parse(c.checkedAt ?? '') < REJECT_KEEP_MS);
      })
      .slice(0, budget);

    const out = []; let streak = 0; let oldStreak = 0; let fetched = 0;
    for (const row of queue) {
      if (fetched > 0) await sleep(PAGE_DELAY_MS, ctx);
      fetched++;
      let posting;
      try { posting = extractJobPosting(await ctx.fetchText(row.url, { redirect: 'follow' })); }
      catch (err) {
        streak++;
        if (streak >= FAIL_STREAK_STOP) {
          if (!out.length && fetched === streak) throw err;
          console.error(`cutshort: stopped after ${streak} failed pages in a row (${out.length} jobs so far): ${err instanceof Error ? err.message : err}`);
          break;
        }
        continue;
      }
      streak = 0;
      if (!posting) continue;
      const r = toJob(row.url, posting, opts, now);
      if ('job' in r) { out.push(r.job); oldStreak = 0; continue; }
      if (r.reject === 'old') { if (++oldStreak >= OLD_STREAK_STOP) break; continue; }
      oldStreak = 0;
      ctx.idCache?.set(`cutshort:${row.url}`, { id: r.reject, checkedAt: new Date().toISOString() });
    }
    return out.sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0));
  },
};
