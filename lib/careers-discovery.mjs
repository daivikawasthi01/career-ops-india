// lib/careers-discovery.mjs: the judgement behind tools/discover-careers.mjs. Pure: no browser, no network.
// Code decides; anything uncertain is marked `needs-review` for a person.

import { readFileSync, existsSync } from 'fs';
import { identityTokens } from './board-identity-names.mjs';
import { brandLabel, labelMatchesName, slugMatchesName } from './board-audit.mjs';

export const TSV_HEADER = ['company', 'domain', 'careers_url', 'ats', 'campus_url', 'confidence', 'notes'].join('\t');

// ATS vendors and how to read the board out of a URL. `tenant: 'host'` = the first host label, 'path' = first path segment.
const ATS_RULES = [
  { ats: 'greenhouse', host: /^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/, tenant: 'path' },
  { ats: 'lever', host: /^jobs(?:\.eu)?\.lever\.co$/, tenant: 'path' },
  { ats: 'ashby', host: /^jobs\.ashbyhq\.com$/, tenant: 'path' },
  { ats: 'workday', host: /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/, tenant: 'host' },
  { ats: 'darwinbox', host: /^([a-z0-9-]+)\.darwinbox\.(?:in|com)$/, tenant: 'host' },
  { ats: 'keka', host: /^([a-z0-9-]+)\.keka\.com$/, tenant: 'host' },
  { ats: 'zoho-recruit', host: /^([a-z0-9-]+)\.zohorecruit\.(?:com|in|eu)$/, tenant: 'host' },
  { ats: 'freshteam', host: /^([a-z0-9-]+)\.freshteam\.com$/, tenant: 'host' },
  { ats: 'smartrecruiters', host: /^(?:careers|jobs)\.smartrecruiters\.com$/, tenant: 'path' },
  { ats: 'workable', host: /^apply\.workable\.com$/, tenant: 'path' },
  { ats: 'recruitee', host: /^([a-z0-9-]+)\.recruitee\.com$/, tenant: 'host' },
  { ats: 'bamboohr', host: /^([a-z0-9-]+)\.bamboohr\.com$/, tenant: 'host' },
  { ats: 'rippling', host: /^ats\.rippling\.com$/, tenant: 'path' },
];
const NOT_A_TENANT = new Set(['www', 'api', 'app', 'static', 'cdn', 'assets', 'help', 'support', 'blog', 'docs', 'status', 'login', 'auth', 'embed', 'resources', 'boards', 'jobs', 'careers']);
const PATH_NOT_TENANT = new Set(['embed', 'v1', 'v0', 'jobs', 'api', 'static', 'assets', 'privacy', 'terms', 'about', 'login', 'sitemap.xml']);

/** {ats, tenant, url} when the URL is a board of a known ATS, else null. A bare vendor root is not a board. */
export function atsFromUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  for (const r of ATS_RULES) {
    const m = host.match(r.host);
    if (!m) continue;
    let tenant = null;
    if (r.tenant === 'host') tenant = m[1];
    else tenant = (u.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
    if (!tenant) return null;
    if (r.tenant === 'host' && NOT_A_TENANT.has(tenant)) return null;
    if (r.tenant === 'path' && PATH_NOT_TENANT.has(tenant)) return null;
    if (r.ats === 'workday') tenant = `${tenant}/${(u.pathname.split('/').filter(Boolean).find((s) => !/^[a-z]{2}-[A-Z]{2}$/.test(s)) || '')}`.replace(/\/$/, '');
    return { ats: r.ats, tenant: tenant.toLowerCase(), url: `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}` };
  }
  return null;
}

/** Distinct ATS boards among `urls`, in first-seen order. */
export function findAtsLinks(urls) {
  const seen = new Set();
  const out = [];
  for (const raw of urls || []) {
    const a = atsFromUrl(raw);
    if (!a) continue;
    const key = `${a.ats}|${a.tenant}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

/** Choose the board that looks like this company's. `slugOk` says whether its tenant resembles the name. */
export function pickAts(links, name) {
  if (!links.length) return { best: null, slugOk: false, others: [] };
  const fits = (l) => slugMatchesName(l.tenant.split('/')[0], name);
  const best = links.find(fits) || links[0];
  return { best, slugOk: fits(best), others: links.filter((l) => l !== best) };
}

const CAMPUS_RE = /\b(campus|early[- ]?careers?|graduates?|freshers?|interns?(hips?)?|university|students?|trainee|apprentice|new[- ]?grad)\b/i;
/** First link that looks like an early-careers / campus / internship page. `links`: [{href, text}]. */
export function findCampusLink(links) {
  for (const l of links || []) {
    if (!/^https?:/i.test(l.href || '')) continue;
    if (/\.(pdf|jpe?g|png|svg)(\?|$)/i.test(l.href)) continue;
    if (CAMPUS_RE.test(l.text || '') || CAMPUS_RE.test(new URL(l.href).pathname.replace(/[/_-]+/g, ' '))) return l.href;
  }
  return null;
}

const CAREERS_RE = /\b(careers?|jobs?|join[- ]us|work[- ]with[- ]us|we'?re[- ]hiring|hiring|openings?|opportunit(?:y|ies))\b/i;
/** Same-site links that look like the careers page. `host` is the company's own host (www ignored). */
export function findCareersLinks(links, host) {
  const own = String(host || '').toLowerCase().replace(/^www\./, '');
  const out = [];
  for (const l of links || []) {
    let u;
    try { u = new URL(l.href); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    const h = u.hostname.toLowerCase().replace(/^www\./, '');
    const sameSite = h === own || h.endsWith(`.${own}`) || own.endsWith(`.${h}`);
    if (!sameSite && !atsFromUrl(l.href)) continue;
    if (CAREERS_RE.test(l.text || '') || CAREERS_RE.test(u.pathname.replace(/[/_-]+/g, ' '))) out.push(l.href);
  }
  return [...new Set(out)];
}

/** Every absolute URL mentioned in a page, whether in an href, a script or JSON. */
export function extractUrls(html) {
  const out = new Set();
  for (const m of String(html || '').matchAll(/https?:\/\/[^\s"'<>)\\]+/gi)) out.add(m[0].replace(/[.,;]+$/, ''));
  return [...out];
}

/** A search engine or site asking for a human. Stops the run; never worked around. */
export function captchaLikely({ status, html, url }) {
  const t = String(html || '').slice(0, 20000).toLowerCase();
  if (status === 429) return true;
  if (/(captcha|are you a human|verify you are human|unusual traffic|anomaly|cf-challenge|just a moment\.\.\.|access denied|attention required)/.test(t)) return true;
  if (/duckduckgo\.com\/anomaly/i.test(String(url || ''))) return true;
  return false;
}

/** Does the page that answered at a guessed domain look like this company's? */
export function homepageMatchesCompany({ title, siteName, text }, name) {
  const tokens = identityTokens(name).filter((t) => t.length >= 3);
  if (!tokens.length) return false;
  const hay = `${title || ''} ${siteName || ''}`.toLowerCase();
  const body = String(text || '').slice(0, 6000).toLowerCase();
  const joined = tokens.join('');
  const compact = (s) => s.replace(/[^a-z0-9]/g, '');
  if (compact(hay).includes(joined)) return true;            // title / site name carries the whole name
  return tokens.every((t) => compact(hay).includes(t)) || (compact(body).includes(joined) && body.split(joined).length > 3);
}

/** Does this URL's host belong to the company? (its known domain, or a brand label that fits the name) */
export function hostMatchesCompany(url, name, knownDomain) {
  let host;
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return false; }
  const known = String(knownDomain || '').toLowerCase().replace(/^www\./, '');
  if (known && (host === known || host.endsWith(`.${known}`))) return true;
  return labelMatchesName(brandLabel(host), name);
}

/** Hosts to try for a company, most likely first. */
export function domainCandidates(name, { hint, override } = {}) {
  const out = [];
  const add = (h) => { const x = String(h || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, ''); if (x && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(x) && !out.includes(x)) out.push(x); };
  add(override);
  add(hint);
  const brand = identityTokens(name).join('');
  if (/^[a-z0-9]{2,}$/.test(brand)) for (const tld of ['com', 'in', 'co.in', 'ai', 'io', 'co', 'org']) add(`${brand}.${tld}`);
  return out;
}

/**
 * The verdict for one company. `high` only when the company's own site, on a domain we verified, links to a board whose
 * tenant looks like the company. A custom careers page on a verified domain is `medium`. Everything else is `needs-review`.
 */
export function classify({ domain, domainVerified, domainSource, ats, slugOk, careersUrl, atsOnOwnSite, viaSearch, pagesLoaded, atsOthers = 0 }) {
  const notes = [];
  if (!pagesLoaded) { notes.push('no page loaded'); return { confidence: 'needs-review', notes }; }
  if (domain && !domainVerified) notes.push(`domain ${domain} is a guess the homepage did not confirm`);
  if (domainSource === 'guess' && domainVerified) notes.push('domain guessed, homepage names the company');
  if (ats && !slugOk) notes.push(`${ats.ats} tenant "${ats.tenant}" does not look like the company name`);
  if (atsOthers) notes.push(`${atsOthers} other ATS link(s) on the page`);
  if (viaSearch) notes.push('found by web search, not on the company site');
  if (ats && domainVerified && atsOnOwnSite && slugOk && !viaSearch) return { confidence: 'high', notes };
  if (!ats && careersUrl && domainVerified && !viaSearch) { notes.push('custom careers page, no ATS link found'); return { confidence: 'medium', notes }; }
  if (!ats && !careersUrl) notes.push('no careers page or ATS board found');
  return { confidence: 'needs-review', notes };
}

/** One TSV line. Tabs and newlines in values are flattened. */
export function toRow(r) {
  const f = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  return [r.company, r.domain, r.careers_url, r.ats, r.campus_url, r.confidence, r.notes].map(f).join('\t');
}

/** Company names already in the output file (for resume). */
export function readDone(path) {
  if (!existsSync(path)) return new Set();
  const done = new Set();
  for (const line of readFileSync(path, 'utf-8').split('\n').slice(1)) {
    const c = line.split('\t');
    if (c[0]) done.add(c[0].toLowerCase());
  }
  return done;
}

const unq = (v) => String(v).trim().replace(/^(['"])(.*)\1$/, '$2');

/**
 * Companies to look at, deduplicated, each with where it came from and any hint from portals.yml.
 * @param {{protectedText?: string, portalsEntries?: object[], checkByHandText?: string, extraNames?: string[], only?: string[]}} src
 */
export function buildInputs({ protectedText = '', portalsEntries = [], checkByHandText = '', extraNames = [], only = [] }) {
  const byKey = new Map();
  const entryByKey = new Map(portalsEntries.filter((e) => e && typeof e.name === 'string').map((e) => [e.name.toLowerCase(), e]));
  const add = (name, source) => {
    const n = unq(name);
    if (!n) return;
    const k = n.toLowerCase();
    if (!byKey.has(k)) byKey.set(k, { name: n, sources: [], entry: entryByKey.get(k) || null });
    const rec = byKey.get(k);
    if (!rec.sources.includes(source)) rec.sources.push(source);
  };
  for (const l of protectedText.split('\n')) { const t = l.replace(/#.*/, '').trim(); if (t) add(t, 'protected'); }
  for (const e of portalsEntries) if (e && e.watch === true && typeof e.name === 'string') add(e.name, 'watch');
  for (const l of checkByHandText.split('\n')) { if (!l.trim() || l.startsWith('#')) continue; add(l.split('\t')[0], 'check-by-hand'); }
  for (const n of extraNames) add(n, 'list');
  let list = [...byKey.values()];
  if (only.length) { const want = new Set(only.map((s) => s.toLowerCase())); list = list.filter((r) => want.has(r.name.toLowerCase())); }
  return list;
}

/** First 10-company timing report. */
export function timingReport(secondsPerCompany, total) {
  const n = secondsPerCompany.length;
  const avg = n ? secondsPerCompany.reduce((a, b) => a + b, 0) / n : 0;
  return { n, avg_seconds: Math.round(avg * 10) / 10, estimated_total_minutes: Math.round((avg * total) / 6) / 10 };
}
