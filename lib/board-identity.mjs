// lib/board-identity.mjs: is this ATS board really the company's own?
//
// A board that answers with real jobs proves nothing about whose jobs they are: "Walmart" on
// BambooHR is a Utah firm, "Vivo" a Guatemalan one, "Clay" a Dutch hotel group. discover-ats
// guesses slugs from names, so every match needs evidence before it counts as employer-confirmed.
//
// Evidence, strongest first:
//   owner-name  the ATS publishes the board owner (Greenhouse, Ashby, Lever) and the name matches
//   website     the company's own site links to this exact board (slug included)
// Anything else is "review": it goes to a review file for a human, never into portals.yml.

import { parseAtsSlug, ATS } from '../verify-portals.mjs';
import { dirname } from 'path';
import { nameIdentityVerdict, identityTokens } from './board-identity-names.mjs';

export { nameIdentityVerdict };

// Hosts where the tenant is the first path segment, so host alone does not identify a board.
const PATH_TENANT_HOSTS = new Set([
  'careers.smartrecruiters.com', 'jobs.smartrecruiters.com', 'ats.rippling.com', 'join.com',
  'www.join.com', 'apply.workable.com', 'jobs.workable.com', 'app.dover.com',
]);

/** A stable key for "which board is this URL": vendor+slug, or host (+ first segment on shared hosts). */
export function boardKey(url) {
  const text = String(url || '').trim();
  const parsed = parseAtsSlug(text);
  if (parsed) return `${parsed.ats}|${String(parsed.slug).toLowerCase()}`;
  let u;
  try { u = new URL(text); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (PATH_TENANT_HOSTS.has(host)) {
    const seg = u.pathname.split('/').filter(Boolean);
    const first = host.endsWith('join.com') && seg[0] === 'companies' ? seg[1] : seg[0];
    return first ? `${host}|${first.toLowerCase()}` : null;
  }
  return host;
}

/** {ats, slug} for a board URL: the three ATSs parseAtsSlug knows, plus tenant-host and path-tenant vendors. */
export function vendorSlug(url) {
  const parsed = parseAtsSlug(String(url || ''));
  if (parsed) return { ats: parsed.ats, slug: String(parsed.slug).toLowerCase() };
  let u;
  try { u = new URL(String(url || '')); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean);
  const sub = (d) => (host.endsWith(`.${d}`) ? host.slice(0, -d.length - 1).split('.').pop() : null);
  for (const [ats, d] of [['recruitee', 'recruitee.com'], ['bamboohr', 'bamboohr.com'], ['breezy', 'breezy.hr'], ['pinpoint', 'pinpointhq.com'], ['teamtailor', 'teamtailor.com']]) {
    const s = sub(d);
    if (s) return { ats, slug: s };
  }
  if (host === 'careers.smartrecruiters.com' || host === 'jobs.smartrecruiters.com') return seg[0] ? { ats: 'smartrecruiters', slug: seg[0].toLowerCase() } : null;
  if (host === 'ats.rippling.com') return seg[0] ? { ats: 'rippling', slug: seg[0].toLowerCase() } : null;
  if (host === 'join.com' || host === 'www.join.com') return seg[0] === 'companies' && seg[1] ? { ats: 'join', slug: seg[1].toLowerCase() } : null;
  if (host === 'apply.workable.com') return seg[0] ? { ats: 'workable', slug: seg[0].toLowerCase() } : null;
  return null;
}

export const APPROVED_HEADER = ['board', 'ats', 'slug', 'note'].join('\t');

/** Parse data/identity-approved.tsv into a Set of "ats|slug". A missing file approves nothing. */
export function loadApproved(path, fs) {
  const out = new Set();
  if (!path || !fs.existsSync(path)) return out;
  for (const line of fs.readFileSync(path, 'utf-8').split('\n').slice(1)) {
    const c = line.split('\t');
    if (c[1] && c[2]) out.add(`${c[1].trim().toLowerCase()}|${c[2].trim().toLowerCase()}`);
  }
  return out;
}

/** Sites to try for a company: the declared website, else the brand as a domain on common TLDs. */
export function siteCandidates(name, website) {
  const hosts = [];
  if (website) {
    try { hosts.push(new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname); } catch { /* ignore */ }
  }
  if (!hosts.length) {
    const brand = identityTokens(name).join('');
    if (/^[a-z0-9]{2,}$/.test(brand)) for (const tld of ['com', 'ai', 'io', 'in', 'co', 'org']) hosts.push(`${brand}.${tld}`);
  }
  return [...new Set(hosts)];
}

/** Every absolute URL mentioned in a page, whether in an href, a script or JSON. */
export function extractUrls(html) {
  const out = new Set();
  for (const m of String(html || '').matchAll(/https?:\/\/[^\s"'<>)\\]+/gi)) out.add(m[0].replace(/[.,;]+$/, ''));
  return [...out];
}

// Vendors that give each tenant its own subdomain: for these the host IS the board.
const SUBDOMAIN_TENANT_DOMAINS = ['bamboohr.com', 'recruitee.com', 'breezy.hr', 'pinpointhq.com', 'teamtailor.com'];
const isTenantHost = (key) => SUBDOMAIN_TENANT_DOMAINS.some((d) => key.endsWith(`.${d}`) && key !== `www.${d}`);

/** The first URL in `urls` that points at the same board as `boardUrl`, or null. */
export function linkToBoard(urls, boardUrl) {
  const want = boardKey(boardUrl);
  // A bare host would match any page on that host, so only vendor|slug keys and tenant subdomains count.
  if (!want || !(want.includes('|') || isTenantHost(want))) return null;
  return urls.find((u) => boardKey(u) === want) || null;
}

/**
 * Does the company's own site link to this exact board?
 * Fetches the home page and, when it has no such link, /careers and /jobs on the same host.
 * `fetchText(url)` must resolve to the page text or throw.
 */
export async function websiteConfirms({ name, website, boardUrl }, { fetchText, maxHosts = 5 }) {
  const tried = [];
  for (const host of siteCandidates(name, website).slice(0, maxHosts)) {
    let reached = false;
    for (const path of ['/', '/careers', '/jobs']) {
      const url = `https://${host}${path}`;
      let html;
      try { html = await fetchText(url); } catch { if (path === '/') break; continue; }
      reached = true;
      const hit = linkToBoard(extractUrls(html), boardUrl);
      if (hit) return { ok: true, site: host, page: url, link: hit };
    }
    tried.push(reached ? `${host} (no link to this board)` : `${host} (unreachable)`);
  }
  return { ok: false, tried };
}

/**
 * Decide whether a resolved board belongs to the company.
 * @param {{name: string, careers_url: string, vendor?: string}} board
 * @param {{website?: string}} company
 * @param {{fetchText: Function, fetchJson?: Function}} io
 * @returns {Promise<{status: 'confirmed'|'review', via: string|null, reason: string, owner?: string, evidence?: object}>}
 */
export async function confirmBoardIdentity(board, company, { fetchText, fetchJson, approved = new Set() }) {
  const vs = vendorSlug(board.careers_url);
  if (vs && approved.has(`${vs.ats}|${vs.slug}`)) {
    return { status: 'confirmed', via: 'approved', employerConfirmed: true, reason: 'listed in data/identity-approved.tsv' };
  }
  const parsed = parseAtsSlug(board.careers_url) || null;
  const spec = parsed && ATS[parsed.ats]?.ownerUrl ? ATS[parsed.ats] : null;
  let ownerReason = 'no owner endpoint for this ATS';
  let owner;
  if (spec) {
    try {
      const url = spec.ownerUrl(parsed.slug, { eu: parsed.eu });
      const raw = spec.ownerKind === 'html' ? await fetchText(url) : await fetchJson(url);
      owner = spec.ownerName(raw);
      if (!owner) ownerReason = 'board publishes no owner name';
      else {
        const v = nameIdentityVerdict(board.name, owner);
        if (v.match) return { status: 'confirmed', via: 'name', employerConfirmed: false, reason: `owner "${owner}" matches by name (${v.how}); name only, not employer-confirmed`, owner };
        ownerReason = `owner "${owner}" is a different name`;
      }
    } catch (err) {
      ownerReason = `owner lookup failed: ${String(err?.message || err).slice(0, 60)}`;
    }
  }
  const site = await websiteConfirms({ name: board.name, website: company?.website, boardUrl: board.careers_url }, { fetchText });
  if (site.ok) return { status: 'confirmed', via: 'website', employerConfirmed: true, reason: `${site.site} links to this board`, owner, evidence: site };
  return {
    status: 'review', via: null,
    reason: `${ownerReason}; website: ${site.tried.length ? site.tried.join(', ') : 'no site to try'}`,
    owner, evidence: site,
  };
}

/**
 * Split discovered boards into those that passed the check and those that need a human.
 * Bounded concurrency; one failing lookup never aborts the rest.
 */
export async function gateByIdentity(resolved, companies, io, { concurrency = 2, onProgress } = {}) {
  const byName = new Map((companies || []).map((c) => [c.name, c]));
  const confirmed = [];
  const review = [];
  let i = 0;
  const worker = async () => {
    while (i < resolved.length) {
      const board = resolved[i++];
      let verdict;
      try { verdict = await confirmBoardIdentity(board, byName.get(board.name), io); }
      catch (err) { verdict = { status: 'review', via: null, reason: `check failed: ${String(err?.message || err).slice(0, 80)}` }; }
      (verdict.status === 'confirmed' ? confirmed : review).push({ ...board, identity: verdict });
      onProgress?.({ name: board.name, status: verdict.status });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, resolved.length) }, worker));
  return { confirmed, review };
}

/** Append review rows to `path`, skipping a company+URL already listed. Returns how many were added. */
export function appendReviewFile(path, review, date, fs) {
  const { existsSync, readFileSync, appendFileSync, mkdirSync } = fs;
  mkdirSync(dirname(path), { recursive: true });
  const have = new Set();
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf-8').split('\n').slice(1)) {
      const c = line.split('\t');
      if (c[1]) have.add(`${c[1]}\t${c[3]}`);
    }
  }
  const fresh = review.filter((r) => !have.has(`${r.name}\t${r.careers_url}`));
  if (!fresh.length) return 0;
  const body = reviewRows(fresh, date).join('\n') + '\n';
  appendFileSync(path, existsSync(path) ? body : `${REVIEW_HEADER}\n${body}`);
  return fresh.length;
}

export const CONFIRMED_HEADER = ['date', 'company', 'ats', 'slug', 'how_confirmed', 'employer_confirmed', 'reason'].join('\t');

/** Append one line per confirmed board: how it was confirmed (name, website or approved). */
export function appendConfirmedLog(path, confirmed, date, fs) {
  if (!confirmed.length) return 0;
  const { existsSync, appendFileSync, mkdirSync } = fs;
  mkdirSync(dirname(path), { recursive: true });
  const f = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  const rows = confirmed.map((b) => {
    const vs = vendorSlug(b.careers_url) || {};
    return [date, b.name, vs.ats, vs.slug, b.identity?.via, b.identity?.employerConfirmed ? 'yes' : 'no', b.identity?.reason].map(f).join('\t');
  });
  appendFileSync(path, (existsSync(path) ? '' : `${CONFIRMED_HEADER}\n`) + rows.join('\n') + '\n');
  return rows.length;
}

export const REVIEW_HEADER = ['date', 'company', 'vendor', 'careers_url', 'jobs', 'reason', 'owner'].join('\t');

/** One TSV line per review item. Tabs and newlines in values are flattened. */
export function reviewRows(review, date) {
  const f = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  return review.map((r) => [date, r.name, r.vendor, r.careers_url, r.jobCount ?? '', r.identity?.reason, r.identity?.owner].map(f).join('\t'));
}

