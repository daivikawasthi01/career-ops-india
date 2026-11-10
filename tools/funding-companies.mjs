#!/usr/bin/env node
/**
 * funding-companies.mjs: newly funded Indian startups, as a SEPARATE list for the discovery pipeline.
 * Reads public funding-news RSS feeds (Inc42, Entrackr), keeps headlines of the "<Company> raises/bags/secures $X" shape,
 * and appends new company names to data/funding-companies.txt (one per line; never touches companies.txt).
 * A funded startup is a hiring signal: feed that file to discover-careers.mjs --companies like the other name lists.
 *
 *   node tools/funding-companies.mjs            all feeds
 *   node tools/funding-companies.mjs --days 14  only items newer than N days (default 30)
 *
 * A feed that fails or returns something that is not RSS is reported and skipped; the others still run.
 */
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const JOBAPPLY = resolve(HERE, '..', '..');
const DATA = join(process.env.CAREER_OPS_ROOT || join(JOBAPPLY, 'career-ops'), 'data');
export const FEEDS = [['inc42', 'https://inc42.com/buzz/feed/'], ['entrackr', 'https://entrackr.com/rss']];

const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&#8217;|&#039;|&#39;/g, "'").replace(/&#8211;|&#8212;/g, '-').replace(/&quot;|&#8220;|&#8221;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
const VERB = /\s+(?:raises?|raised|bags?|bagged|secures?|secured|lands?|lock(?:s|ed)?|gets?|picks? up|mops? up|snags?|closes?|nets?|receives?|gains?|attracts?|pockets?|garners?|pulls? in|infuses?|funds?|backs?)\b/i;
const MONEY = /(?:\$|₹|rs\.?|inr|usd|crore|cr\b|mn\b|million|billion|lakh|funding|seed|series\s+[a-e]\b|pre-seed|round)/i;

/** Company from a funding headline, or null. "Zepto raises $350 Mn" -> "Zepto"; non-funding headlines -> null. */
export function companyFromHeadline(title) {
  const t = decode(title).replace(/\s+/g, ' ');
  const m = VERB.exec(t);
  if (!m || !MONEY.test(t)) return null;
  let name = t.slice(0, m.index).replace(/^(?:exclusive|breaking|funding galore|funding roundup)\s*[:|-]\s*/i, '').trim();
  name = name.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}).]+$/gu, '').trim();
  if (name.length < 2 || name.length > 40 || name.split(' ').length > 5) return null;
  if (/^(?:indian|startups?|the|a|an|this|these|top|how|why|what|govt|government|sebi|rbi|vcs?|investors?|fintech|edtech|saas|ai|d2c|funding)\b/i.test(name)) return null;
  return name;
}

export function parseFeed(xml, sinceMs = 0) {
  if (!/<rss[\s>]/i.test(xml)) throw new Error('not an RSS feed');
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const title = (/<title>([\s\S]*?)<\/title>/i.exec(m[1]) || [])[1];
    const when = Date.parse(((/<pubDate>([\s\S]*?)<\/pubDate>/i.exec(m[1]) || [])[1] || '').trim());
    if (!title || (sinceMs && !Number.isNaN(when) && when < sinceMs)) continue;
    const name = companyFromHeadline(title);
    if (name) out.push(name);
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const days = Number(argv[argv.indexOf('--days') + 1]) || 30;
  mkdirSync(DATA, { recursive: true });
  const file = join(DATA, 'funding-companies.txt');
  const key = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const have = new Set((existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []).map(key));
  let added = 0, failed = 0;
  for (const [label, url] of FEEDS) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(25000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; career-ops funding-feed)' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const names = parseFeed(await r.text(), Date.now() - days * 864e5);
      let n = 0; for (const name of names) { const k = key(name); if (!k || have.has(k)) continue; have.add(k); appendFileSync(file, name + '\n'); n++; added++; }
      console.log(`  ${label}: ${names.length} funding headlines, ${n} new companies`);
    } catch (e) { failed++; console.error(`  ${label}: skipped (${e.message})`); }
  }
  console.log(`funding-companies: ${added} new names in ${file}${failed ? `; ${failed} feed(s) failed` : ''}`);
  if (failed === FEEDS.length) process.exit(1);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exit(1); });
