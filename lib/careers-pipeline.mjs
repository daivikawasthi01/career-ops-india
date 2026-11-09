/**
 * lib/careers-pipeline.mjs: the code layers of the discover-careers pipeline (no browser, no LLM; every network piece is injected).
 *
 *   L0 gather   search results, homepage text, board fingerprint     (tools/discover-careers.mjs)
 *   L1 domain   LLM picks among L0 candidates                        (lib/careers-llm.mjs)
 *   L2 domain   DNS / HTTP / redirect / parked / bot-wall checks      checkDomain()
 *   L3 probe    Playwright careers page + ATS detection              (tools/discover-careers.mjs)
 *   L4 verify   independent LLM check of the page                    (lib/careers-llm.mjs)
 *   L5 compare  discovered ATS vs portals.yml board, fingerprint      compareAts(), fingerprintFit()
 *   L6 gate     accept only when every gate agrees                    gate()
 */
import dns from 'node:dns/promises';
import { atsFromUrl, hostMatchesCompany } from './careers-discovery.mjs';

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu']);
/** example.co.in -> example.co.in, www.sub.example.com -> example.com */
export function registrable(host) {
  const p = String(host || '').toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  if (p.length <= 2) return p.join('.');
  return (p[p.length - 1].length === 2 && SECOND_LEVEL.has(p[p.length - 2]) ? p.slice(-3) : p.slice(-2)).join('.');
}
export const sameSite = (a, b) => registrable(a) === registrable(b);

const AGGREGATORS = /(^|\.)(linkedin|glassdoor|indeed|naukri|ambitionbox|wikipedia|facebook|instagram|twitter|x|youtube|crunchbase|zaubacorp|tracxn|medium|reddit|quora|instahyre|cutshort|foundit|monster|simplyhired|ziprecruiter|owler|zoominfo|pitchbook|g2|capterra|trustpilot|bloomberg|economictimes|livemint|moneycontrol|inc42|yourstory|github|duckduckgo|google|apple|brave|bing)\.[a-z.]+$/;
/** A host that lists companies rather than being one. A host whose own name is the company's (shine.com for Shine) is kept. */
export function isAggregator(host, name) {
  const h = String(host || '').toLowerCase();
  return AGGREGATORS.test(h) && !hostMatchesCompany(`https://${h}/`, name, '');
}

// ---- L2 ----
export function classifyFetch({ status, error }) {
  if (error) {
    const m = `${error.code || ''} ${error.cause?.code || ''} ${error.name || ''} ${error.message || ''}`;
    if (/ENOTFOUND|getaddrinfo/i.test(m)) return 'dns';
    if (/timeout|ETIMEDOUT|abort/i.test(m)) return 'timeout';
    return 'error';
  }
  if (status >= 200 && status < 400) return 'ok';
  if (status === 404 || status === 410) return '404';
  if (status === 403) return '403';
  if (status === 429) return '429';
  if (status >= 500) return '5xx';
  return 'other';
}
export const retryable = (c) => c === '429' || c === '5xx' || c === 'timeout';

const PARKED = /(domain (is )?(for sale|may be for sale)|buy this domain|this domain (has been|is) (registered|parked)|parked (free|domain)|sedo\.com|hugedomains|dan\.com\/buy|godaddy\.com\/domainsearch|coming soon\b.{0,40}\bdomain)/i;
export const isParked = (text) => PARKED.test(String(text || '').slice(0, 4000)) || (String(text || '').trim().length < 80 && /parked|for sale/i.test(text || ''));
export const botWall = (status, text) => status === 403 || status === 429 || /just a moment|attention required|verify you are (a )?human|access denied|captcha/i.test(String(text || '').slice(0, 1500));

/**
 * L2. Resolve and fetch https://domain/ with backoff on 429/5xx/timeout. Returns
 * { class, status, finalHost, parked, botWall, redirectedAway, attempts }. `deps` is injectable for tests.
 */
export async function checkDomain(domain, { fetchImpl = fetch, lookup = dns.lookup, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), tries = 3, timeoutMs = 15000 } = {}) {
  const out = { domain, class: 'error', status: 0, finalHost: '', parked: false, botWall: false, redirectedAway: false, attempts: 0 };
  try { await lookup(domain); } catch (error) { return { ...out, class: classifyFetch({ error }) === 'dns' ? 'dns' : 'timeout' }; }
  for (let i = 0; i < tries; i++) {
    out.attempts++;
    let res; let text = '';
    try {
      res = await fetchImpl(`https://${domain}/`, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'Mozilla/5.0 (compatible; career-ops discovery)' } });
      text = await res.text().catch(() => '');
      out.class = classifyFetch({ status: res.status });
      out.status = res.status;
      out.finalHost = new URL(res.url || `https://${domain}/`).hostname.replace(/^www\./, '');
    } catch (error) { out.class = classifyFetch({ error }); }
    out.parked = isParked(text);
    out.botWall = out.status ? botWall(out.status, text) : false;
    out.redirectedAway = Boolean(out.finalHost) && !sameSite(out.finalHost, domain) && !atsFromUrl(`https://${out.finalHost}/`);
    if (!retryable(out.class)) return out;
    await sleep(1000 * 2 ** i);
  }
  return out;
}

// ---- L1 helpers ----
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
/** The quote the model gives as evidence must literally occur in what we showed it. */
export const quoteInEvidence = (quote, texts) => norm(quote).length >= 8 && texts.some((t) => norm(t).includes(norm(quote)));

/** Accept a model's domain only if L0 produced it, and its quote is real. */
export function checkL1(raw, candidates, evidenceTexts) {
  if (!raw) return { ok: false, why: 'no usable answer' };
  if (raw.domain == null || raw.domain === 'none') return { ok: false, none: true, why: 'model found no official domain among the candidates' };
  const domain = String(raw.domain).toLowerCase().replace(/^www\./, '');
  const known = candidates.find((c) => sameSite(c.domain, domain));
  if (!known) return { ok: false, why: `model named ${domain}, which is not an L0 candidate` };
  if (raw.confidence === 'low') return { ok: false, why: 'low confidence' };
  if (!quoteInEvidence(raw.evidence_quote, evidenceTexts)) return { ok: false, why: 'evidence quote is not in the supplied text' };
  return { ok: true, domain: known.domain };
}

// ---- L5 ----
const tenantOf = (a) => String(a?.tenant || '').split('/')[0].toLowerCase();
/** Discovered ATS (from the site) against the board in portals.yml. */
export function compareAts(found, boardUrl) {
  if (!boardUrl) return { state: 'no-board' };
  const b = atsFromUrl(boardUrl);
  if (!b) return { state: 'no-board', detail: 'portals entry is not an ATS board' };
  if (!found) return { state: 'no-ats-found', detail: `portals has ${b.ats}/${tenantOf(b)}` };
  return found.ats === b.ats && tenantOf(found) === tenantOf(b)
    ? { state: 'same', detail: `${b.ats}/${tenantOf(b)}` }
    : { state: 'different', detail: `site shows ${found.ats}/${tenantOf(found)}, portals has ${b.ats}/${tenantOf(b)}` };
}

/** Board fingerprint: counts over every posting plus 10 sample titles with locations (India ones first). */
export function boardFingerprint(jobs, inIndia) {
  const list = (jobs || []).map((j) => ({ title: String(j.title || '').slice(0, 90), location: String(j.location || '').slice(0, 60), india: Boolean(inIndia(j.location, j.url, j.title, j)) }));
  const sample = [...list.filter((j) => j.india), ...list.filter((j) => !j.india)].slice(0, 10).map(({ title, location }) => ({ title, location }));
  return { total: list.length, india_any: list.filter((j) => j.india).length, sample };
}
/** Does the board look like the profile? An Indian-HQ profile with a real-size board and no India posting does not. */
export function fingerprintFit(fp, profile) {
  if (!fp) return { state: 'no-board' };
  if (profile.expectIndia && fp.total >= 8 && fp.india_any === 0) return { state: 'mismatch', detail: `${fp.total} postings, none in India, for an Indian-HQ company` };
  return { state: 'fits', detail: `${fp.india_any}/${fp.total} in India` };
}

/** Bing wraps result links as bing.com/ck/a?...&u=a1<base64url of the real URL>. Returns the real URL, or the input if it is not wrapped. */
export function unwrapBingUrl(href) {
  try {
    const u = new URL(href);
    if (!/(^|\.)bing\.com$/.test(u.hostname)) return href;
    const t = u.searchParams.get('u');
    if (!t || !t.startsWith('a1')) return href;
    const out = Buffer.from(t.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return /^https?:\/\//.test(out) ? out : href;
  } catch { return href; }
}

/** Strip anything that looks like an API key or an Authorization header from text that may be logged or written. */
export function redact(text) {
  return String(text ?? '')
    .replace(/(authorization["']?\s*[:=]\s*["']?)(bearer\s+)?[^\s"',;]+/gi, '$1[redacted]')
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
    .replace(/\b(gsk|sk|xai|ghp)_[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/(api[_-]?key["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[redacted]');
}

// ---- L6 ----
/**
 * Every gate must agree. A gate is true (pass), false (fail) or null (not applicable). Returns { accepted, failed[], gates }.
 * `needLlm`: L1 and L4 must have run and agreed, otherwise the row is queued ("no verifier").
 */
export function gate({ l1, l2, l3, l4, l5ats, l5fp, fb = {} }, { needLlm = true } = {}) {
  const gates = {
    domain: l1?.ok ?? (needLlm ? false : null),
    reachable: l2 ? (l2.class === 'ok' || l2.class === '403' || l2.class === '429') && !l2.parked && !l2.redirectedAway : false,
    careers: Boolean(l3?.careersUrl),
    verifier: l4 ? l4.ok : (needLlm ? false : null),
    ats_vs_board: l5ats ? (l5ats.state === 'same' ? true : l5ats.state === 'no-board' ? null : false) : null,
    fingerprint: l5fp ? (l5fp.state === 'fits' ? true : l5fp.state === 'mismatch' ? false : null) : null,
    // The independent verifier must be decided by the primary model. A fallback L1 with a primary L4 may still pass.
    primary_model: fb.l4 ? false : null,
  };
  const why = {
    domain: l1?.why || 'domain not chosen', reachable: l2 ? `domain check: ${l2.class}${l2.parked ? ', parked' : ''}${l2.redirectedAway ? `, redirects to ${l2.finalHost}` : ''}` : 'no domain',
    careers: 'no careers page or ATS link found on the site', verifier: l4?.why || 'verifier did not run',
    ats_vs_board: l5ats?.detail || '', fingerprint: l5fp?.detail || '', primary_model: 'the verifier (L4) was decided by the fallback model',
  };
  const failed = Object.entries(gates).filter(([, v]) => v === false).map(([k]) => `${k}: ${why[k]}`);
  return { accepted: failed.length === 0, failed, gates };
}

/** Different search queries for the one retry. */
export const queryVariants = (name, profile) => [`${name} careers sde india`, `${name} careers india`, `${name} official website india`, `${name} jobs india ${profile.hint || ''}`.trim()];
/** Pass 1 merges the first and third forms; the retry pass merges the second and fourth. */
export const queryPair = (name, profile, pass) => { const q = queryVariants(name, profile); return pass === 0 ? [q[0], q[2]] : [q[1], q[3]]; };

/**
 * Adaptive search pacing. A search that returns nothing from every engine counts as a block: the active lanes halve (never below 1),
 * the spacing grows, and every search pauses for a cooldown that doubles on each block in a row (30 s up to 10 min). After
 * `recoverAfter` good searches the spacing shrinks, then lanes are added back one at a time. Many blocks in a row with no good search
 * in between means the engine is closed to us: `shouldHalt()`.
 */
export class SearchGovernor {
  constructor({ lanes = 3, recoverAfter = 15, haltAfter = 6, now = () => Date.now() } = {}) {
    Object.assign(this, { maxLanes: lanes, active: lanes, extraMs: 0, pauseUntil: 0, okStreak: 0, blocksInRow: 0, totalBlocks: 0, recoverAfter, haltAfter, now });
  }
  pauseMs() { return Math.max(0, this.pauseUntil - this.now()); }
  spacingMs(rand = Math.random()) { return 2000 + rand * 1500 + this.extraMs; }
  ok() {
    this.blocksInRow = 0;
    if (++this.okStreak < this.recoverAfter) return;
    this.okStreak = 0;
    if (this.extraMs > 0) this.extraMs = this.extraMs <= 1000 ? 0 : Math.floor(this.extraMs / 2);
    else if (this.active < this.maxLanes) this.active++;
  }
  blocked() {
    this.okStreak = 0; this.totalBlocks++;
    this.blocksInRow++;
    this.active = Math.max(1, Math.floor(this.active / 2));
    this.extraMs = Math.min(8000, this.extraMs ? this.extraMs * 2 : 2000);
    this.pauseUntil = this.now() + Math.min(600_000, 30_000 * 2 ** (this.blocksInRow - 1));
  }
  shouldHalt() { return this.blocksInRow >= this.haltAfter; }
  /** After a human cleared the block: forget it and start gently. */
  reset() { this.blocksInRow = 0; this.okStreak = 0; this.pauseUntil = 0; this.active = 1; this.extraMs = Math.min(this.extraMs, 2000); }
}
