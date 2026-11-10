// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { fetchTextWithRetry } from './_http.mjs';
import { htmlToText } from './_html-to-text.mjs';
import { decodeEntities } from './_html-entities.mjs';

// Off-campus drive blogs (WordPress RSS): freshershunt.in, freshersdunia.in, offcampusjobs4u.com, freshersnow.com, fresheropenings.com, freshersarea.in.
// These are AGGREGATORS: each post names an employer and links on to the employer's own page, so a row from here is
// UNCONFIRMED until it is found at the employer (see AGENTS.md "Aggregator Listings"). The hosts are listed in
// config/pipeline.yml aggregator_hosts so the pipeline treats them that way.
//
// Use `provider: offcampus-rss` with `feed:` set to one of the allowed feeds (the default is offcampusjobs4u):
//   feed: https://freshersdunia.in/feed
//
// The post title carries the employer: "<Company> Recruitment 2026 - <Role>, <City>" / "<Company> Off Campus Drive
// 2026 Hiring <Role>". A post with no readable employer, or a news/result/syllabus/admit-card post, is dropped.

const FEEDS = new Set(['freshershunt.in', 'freshersdunia.in', 'offcampusjobs4u.com', 'freshersnow.com', 'fresheropenings.com', 'freshersarea.in']);
const DEFAULT_FEED = 'https://offcampusjobs4u.com/feed/';
const NOT_A_JOB = /\b(news|result|results|syllabus|admit card|answer key|cut ?off|exam date|notification|scholarship|market today)\b/i;
const CITIES = /\b(bengaluru|bangalore|mumbai|navi mumbai|delhi|new delhi|gurugram|gurgaon|noida|hyderabad|chennai|pune|kolkata|ahmedabad|kochi|jaipur|indore|chandigarh|coimbatore|trivandrum|thiruvananthapuram|nagpur|bhubaneswar|lucknow|mysuru|mysore|remote|pan india|wfh)\b/i;

/** @param {any} entry @returns {string} */
export function resolveFeed(entry) {
  const raw = typeof entry?.feed === 'string' && entry.feed.trim() ? entry.feed.trim() : DEFAULT_FEED;
  let u; try { u = new URL(raw); } catch { throw new Error(`offcampus-rss: bad feed URL ${raw}`); }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (u.protocol !== 'https:' || !FEEDS.has(host)) throw new Error(`offcampus-rss: feed host ${u.hostname} is not one of ${[...FEEDS].join(', ')}`);
  return `https://${u.hostname}${u.pathname.replace(/\/*$/, '/')}`; // WordPress answers /feed with a 301 to /feed/; redirects are refused, so ask for the final URL
}

const tag = (xml, name) => { const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml); return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : ''; };

/**
 * Split a post title into employer / role / location. Exported for tests.
 * @param {string} title
 */
export function parseTitle(title) {
  const t = decodeEntities(title).replace(/\s+/g, ' ').trim();
  const m = /^(.{2,60}?)\s+(?:(?:Freshers?|IT|Off[- ]?Campus)\s+)*(?:Recruitment|Hiring|Off[- ]?Campus(?:\s+Drive)?|Internship|Walk[- ]?in|Drive|Job Alert)\b/i.exec(t);
  if (!m) return null;
  const company = m[1].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}).]+$/gu, '').trim();
  if (company.length < 2 || /^(new|latest|top|big|mega|hot|urgent|jobs?|freshers?)$/i.test(company)) return null;
  const rest = t.slice(m[0].length).replace(/^[\s\-–—:|]*(?:20\d\d)?[\s\-–—:|]*(?:Hiring)?[\s\-–—:|]*/i, '');
  const role = rest.split(/\s+[|–—]\s+|\s+Apply\b|\s+(?:Job\s+)?For Freshers\b|\s+Job$/i)[0].replace(/,\s*[^,]+$/, (x) => (CITIES.test(x) ? '' : x)).trim() || t;
  const loc = (CITIES.exec(rest) || [])[0];
  return { company, role: role.slice(0, 140), location: loc ? loc.replace(/\b\w/g, (c) => c.toUpperCase()) : 'India' };
}

/**
 * @param {string} xml
 * @returns {import('./_types.js').Job[]}
 */
export function parseFeed(xml) {
  if (!/<rss[\s>]/i.test(xml) || !/<channel[\s>]/i.test(xml)) throw new Error('offcampus-rss: response is not an RSS feed');
  const jobs = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const item = m[1];
    const title = tag(item, 'title'); const link = tag(item, 'link');
    const cats = [...item.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/gi)].map((c) => c[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).join(' ');
    if (!title || !/^https:\/\//.test(link) || NOT_A_JOB.test(title) || NOT_A_JOB.test(cats)) continue;
    const p = parseTitle(title);
    if (!p) continue;
    /** @type {import('./_types.js').Job} */
    const job = { title: p.role, url: link, company: p.company, location: p.location };
    const when = Date.parse(tag(item, 'pubDate')); if (!Number.isNaN(when)) job.postedAt = when;
    const body = htmlToText(tag(item, 'content:encoded') || tag(item, 'description'));
    if (body) job.description = `Aggregator post (unconfirmed until found at the employer). Categories: ${cats.trim()}. ${body}`.slice(0, 4000);
    jobs.push(job);
  }
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'offcampus-rss',
  detect(_entry) { return null; },
  async fetch(entry, ctx) {
    const xml = await fetchTextWithRetry(ctx, resolveFeed(entry), { redirect: 'error', timeoutMs: 30000 });
    return parseFeed(xml);
  },
};
