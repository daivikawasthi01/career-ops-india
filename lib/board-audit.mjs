// lib/board-audit.mjs: cheap evidence that a tracked board belongs to the company it is named after.
// Pure: no network. audit-board-identity.mjs gathers the inputs.

import { identityTokens } from './board-identity-names.mjs';

/** Names that are ordinary words or very short brands: a board of that name proves little without more evidence. */
export const GENERIC_NAMES = [
  'Jar', 'Porter', 'Vogo', 'Bounce', 'Eternal', 'Navi', 'Shine', 'Gramophone', 'Pronto', 'Radix', 'Titan', 'Arc',
  'Atlas', 'Make', 'Gamma', 'Mobius', 'Zepto', 'Upstox', 'NoBroker', 'Turtlemint',
];

// Hosts that carry many employers' postings; a posting URL there says nothing about whose it is.
const SHARED_HOSTS = [
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'smartrecruiters.com', 'recruitee.com', 'bamboohr.com', 'rippling.com',
  'join.com', 'workable.com', 'myworkdayjobs.com', 'icims.com', 'jobvite.com', 'teamtailor.com', 'breezy.hr',
  'pinpointhq.com', 'personio.de', 'personio.com', 'applytojob.com', 'taleo.net', 'successfactors.com', 'oraclecloud.com',
  'linkedin.com', 'naukri.com', 'indeed.com', 'glassdoor.com', 'wellfound.com', 'instahyre.com', 'cutshort.io',
  'keka.com', 'darwinbox.in', 'zohorecruit.com', 'freshteam.com',
];

const isShared = (host) => SHARED_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));

/** The brand label of a host: "careers.acme.co.in" -> "acme". */
export function brandLabel(host) {
  const parts = String(host || '').toLowerCase().replace(/^www\./, '').split('.');
  if (parts.length < 2) return parts[0] || '';
  const second = new Set(['co', 'com', 'org', 'net', 'gov', 'ac']);
  return second.has(parts[parts.length - 2]) && parts.length >= 3 ? parts[parts.length - 3] : parts[parts.length - 2];
}

/** Does a brand label plausibly belong to this company name? */
export function labelMatchesName(label, name) {
  const joined = identityTokens(name).join('');
  if (!label || !joined) return false;
  if (label.includes(joined) || (label.length >= 4 && joined.includes(label))) return true;
  return identityTokens(name).some((t) => t.length >= 4 && label.includes(t));
}

/**
 * Posting URLs on the employer's own domain should name the employer. Returns the hosts that do not.
 * Judged only when at least `minOwn` URLs are on an unshared host, and flagged when most of them are off-brand.
 */
export function postingDomainMismatch(name, urls, { minOwn = 3, share = 0.6 } = {}) {
  const hosts = [];
  for (const u of urls || []) {
    try {
      const h = new URL(u).hostname.toLowerCase();
      if (!isShared(h)) hosts.push(h);
    } catch { /* not a URL */ }
  }
  if (hosts.length < minOwn) return { judged: false, own: hosts.length, offBrand: [] };
  const off = hosts.filter((h) => !labelMatchesName(brandLabel(h), name));
  return { judged: true, own: hosts.length, offBrand: off.length / hosts.length >= share ? [...new Set(off)] : [] };
}

/** Does the board slug look like the company name? ("tide" for TIDE yes, "bounceinsights" for Bounce yes, "xyz" no.) */
export function slugMatchesName(slug, name) {
  const s = String(slug || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const joined = identityTokens(name).join('');
  if (!s || !joined) return true; // nothing to compare
  return s.includes(joined) || (s.length >= 3 && joined.includes(s)) || identityTokens(name).some((t) => t.length >= 4 && s.includes(t));
}
