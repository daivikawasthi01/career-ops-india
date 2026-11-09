// lib/careers-pass2.mjs: pure rules for the second pass over discovered careers pages. No network, no browser.
import { sameSite, registrable } from './careers-pipeline.mjs';

/** Best verdict first. A company's final verdict is the best one among everything tried. */
export const VERDICT_RANK = ['jobs-found', 'listings-on-page', 'board-empty', 'listings-unread', 'landing', 'bot-blocked', 'dead-board', 'unreachable', 'not-careers'];
/** Verdicts that end the repair loop. listings-unread: a careers-looking page on the right site whose listings we could not read (client-side). */
export const PASSING = new Set(['jobs-found', 'listings-on-page', 'listings-unread']);
export const CAREERS_PATH = /career|jobs?\b|open-position|opening|vacanc|join|work-with|hiring/i;
export const best = (verdicts) => [...verdicts].sort((a, b) => VERDICT_RANK.indexOf(a) - VERDICT_RANK.indexOf(b))[0] || 'not-careers';

const JOB_WORDS = /\b(open (positions?|roles?)|current (openings?|vacancies)|job openings?|we(?:'| a)re hiring|join (us|our team)|apply now|view (all )?jobs|search jobs|careers?|vacanc(y|ies)|openings?)\b/i;
const EMPTY_PHRASES = /\b(no (open|current|available) (positions?|roles?|openings?|vacancies|jobs)|there are no (open|current) |currently no (open )?(positions?|roles?|openings?|vacancies)|no jobs? (found|available|match)|0 (open )?(jobs?|positions?|roles?)|check back (later|soon)|not hiring right now|no openings)\b/i;
const TITLE_WORDS = /\b(engineer|developer|sde|analyst|manager|designer|scientist|intern(ship)?|associate|consultant|architect|specialist|executive|lead|director|trainee|devops|qa|tester)\b/i;
const JOB_HREF = /(\/jobs?\/|\/job-|\/positions?\/|\/openings?\/|\/vacanc|\/requisition|\/role[s]?\/|[?&](job|gh_jid|jid|req)[=_]|\/apply\b|\/o\/|\/careers\/[^/]+\/[^/]+)/i;
const FOLLOW_TEXT = /\b(open (positions?|roles?)|current (openings?|vacancies)|view (all )?(jobs|openings|roles|positions)|search (jobs|roles)|see (all )?(jobs|roles|openings)|explore (jobs|roles|careers)|all (jobs|openings|positions)|job (search|listings?))\b/i;
const BOT_TEXT = /\b(access denied|you don'?t have permission|attention required|verify you are human|are you a robot|unusual traffic|captcha|request blocked|forbidden)\b/i;

export const looksBotBlocked = ({ status, text = '' }) => status === 403 || status === 429 || (String(text).length < 1500 && BOT_TEXT.test(text));

/** Anchors that look like individual job postings: a job-looking URL or a job-title-looking text, distinct by URL. */
export function jobLinks(links = []) {
  const seen = new Set();
  const out = [];
  for (const l of links) {
    const text = String(l.text || '').trim();
    const ok = (JOB_HREF.test(l.href || '') && text.length >= 4) || (TITLE_WORDS.test(text) && text.length >= 8 && text.length <= 90 && !FOLLOW_TEXT.test(text));
    const key = String(l.href || '').split('#')[0];
    if (ok && key && !seen.has(key)) { seen.add(key); out.push({ href: l.href, text }); }
  }
  return out;
}

/** Links worth following one level to reach the actual listing. */
export const followLinks = (links = [], host = '') => links.filter((l) => FOLLOW_TEXT.test(l.text || '') && l.href && /^https?:/.test(l.href)).filter((l, i, a) => a.findIndex((x) => x.href === l.href) === i).slice(0, 2).map((l) => ({ ...l, sameHost: host ? sameSite(new URL(l.href).hostname, host) : true }));

/**
 * One page, one verdict (the ATS-board path is decided elsewhere, from a real fetch).
 * listings-on-page: three or more distinct job-looking links. board-empty: careers words and an explicit "no openings" phrase.
 * landing: careers words but no listing yet (follow a link). not-careers: neither.
 */
export function classifyPage({ status = 200, text = '', links = [] }) {
  if (looksBotBlocked({ status, text })) return { verdict: 'bot-blocked' };
  const jl = jobLinks(links);
  if (jl.length >= 3) return { verdict: 'listings-on-page', count: jl.length, sample: jl.slice(0, 5).map((j) => j.text) };
  const words = JOB_WORDS.test(text);
  if (words && EMPTY_PHRASES.test(text)) return { verdict: 'board-empty' };
  if (words || jl.length) return { verdict: 'landing' };
  return { verdict: 'not-careers' };
}

const SEARCH_HOSTS = /(^|\.)(bing|duckduckgo|google|yahoo|baidu|yandex)\.[a-z.]+$/i;
const JUNK_HOSTS = /(^|\.)(wikipedia|linkedin|glassdoor|indeed|naukri|ambitionbox|facebook|twitter|x|instagram|youtube|reddit|quora|medium|crunchbase|zaubacorp|tofler|justdial|simplyhired|ziprecruiter|monster|shine|foundit|timesjobs|cutshort|wellfound|instahyre|internshala|unstop|apna)\.[a-z.]+$/i;
const normUrl = (u) => { try { const x = new URL(u); return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}${x.search}`.toLowerCase(); } catch { return String(u).toLowerCase(); } };
export const seen = (tried, url) => tried.has(normUrl(url));
export const mark = (tried, url, verdict) => tried.set(normUrl(url), verdict);

/** New candidate URLs from search results: never tried, not a search engine or a job aggregator, careers-looking ones first. */
export function rankCandidates(results, tried, { limit = 4, companyHost = '', name = '' } = {}) {
  const out = [];
  const tokens = String(name).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  const mentions = (r, host) => !tokens.length || tokens.some((t) => `${host} ${r.url} ${r.title || ''} ${r.snippet || ''}`.toLowerCase().includes(t));
  for (const r of results) {
    let host = ''; try { host = new URL(r.url).hostname; } catch { continue; }
    if (SEARCH_HOSTS.test(host) || JUNK_HOSTS.test(host) || seen(tried, r.url) || !mentions(r, host)) continue;
    const careers = /career|jobs?|join|work-with|openings|hiring|vacanc|talent/i.test(`${r.url} ${r.title}`);
    const own = companyHost && sameSite(host, companyHost);
    const ats = /greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters|workable\.com|myworkdayjobs|darwinbox|keka|zohorecruit|bamboohr|recruitee|breezy|freshteam|icims|jobvite|teamtailor|pinpointhq|personio/i.test(host);
    const score = (careers ? 2 : 0) + (own ? 2 : 0) + (ats ? 1 : 0);
    if (score > 0) out.push({ ...r, score }); // a result with no careers, own-site or ATS signal is never visited
  }
  const uniq = out.filter((r, i, a) => a.findIndex((x) => normUrl(x.url) === normUrl(r.url)) === i);
  return uniq.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Loop limits: the loop ends when a round finds no new URL, after maxRounds, or after maxTests URL tests. */
export const LIMITS = { maxRounds: 3, maxTests: 12, perRound: 4 };
export const shouldStop = ({ round, tests, newCandidates, passed }) => passed || round >= LIMITS.maxRounds || tests >= LIMITS.maxTests || newCandidates === 0;

/** Vision answer to what to do next. */
export function visionAction(v) {
  if (!v) return 'none';
  if (v.state === 'captcha' || v.state === 'blocked') return 'search-blocked';
  if (v.state === 'consent') return 'retry';
  if (v.state === 'results') return 'read-urls';
  return 'retry';
}
export { registrable };

// ---- pass 3: India versions of a careers URL ----
const FOREIGN = new Set(['us', 'usa', 'uk', 'gb', 'ca', 'au', 'de', 'fr', 'es', 'it', 'nl', 'sg', 'jp', 'br', 'mx', 'ie', 'global', 'intl', 'int', 'eu', 'emea', 'apac', 'row']);
const isLocale = (seg) => { const m = /^([a-z]{2})[-_]([a-z]{2,4})$/i.exec(seg); return m ? FOREIGN.has(m[2].toLowerCase()) : FOREIGN.has(seg.toLowerCase()); };
const asIndia = (seg) => { const m = /^([a-z]{2})([-_])([a-z]{2,4})$/i.exec(seg); if (!m) return /^[A-Z]+$/.test(seg) ? 'IN' : 'in'; const up = m[3] === m[3].toUpperCase(); return `${m[1]}${m[2]}${up ? 'IN' : 'in'}`; };

/**
 * Plausible India versions of a careers URL, best guesses first, at most 6, never the URL itself.
 * /us/ -> /in/ and /en-us/ -> /en-in/; country=US -> IN; otherwise /in/ and /en-in/ prefixes before the careers path and an in. subdomain.
 */
export function indiaVariants(url) {
  let u; try { u = new URL(url); } catch { return []; }
  const out = [];
  const add = (x) => { const s = x.toString(); if (s !== u.toString() && !out.includes(s)) out.push(s); };
  const segs = u.pathname.split('/');
  const at = segs.findIndex((s) => s && isLocale(s));
  if (at >= 0) {
    const swap = (rep) => { const c = new URL(u); const t = [...segs]; t[at] = rep; c.pathname = t.join('/'); return c; };
    add(swap(asIndia(segs[at])));
    if (!/[-_]/.test(segs[at])) add(swap(/^[a-z]+$/.test(segs[at]) ? 'en-in' : 'EN-IN'));
  }
  for (const [k, v] of u.searchParams) if (/^(country|locale|region|location|lang|market)$/i.test(k) && /^(us|usa|en[-_]us|gb|uk)$/i.test(v)) { const c = new URL(u); c.searchParams.set(k, /[-_]/.test(v) ? v.replace(/us|gb|uk/i, 'IN') : 'IN'); add(c); }
  if (at < 0) {
    const i = segs.findIndex((s) => /^(careers?|jobs?|join)/i.test(s));
    for (const rep of ['in', 'en-in']) { const t = [...segs]; t.splice(i >= 0 ? i : 1, 0, rep); const c = new URL(u); c.pathname = t.join('/'); add(c); }
    if (!/^in\./.test(u.hostname)) { const c = new URL(u); c.hostname = `in.${u.hostname.replace(/^www\./, '')}`; add(c); }
  }
  return out.slice(0, 6);
}

/** Only these may replace the current portal: same site, or the same ATS tenant. Keeps pass 3 from switching to another company. */
export function sameOwner(a, b, atsOf) {
  try {
    const x = atsOf(a); const y = atsOf(b);
    if (x || y) return Boolean(x && y && x.ats === y.ats && String(x.tenant || '').split('/')[0].toLowerCase() === String(y.tenant || '').split('/')[0].toLowerCase());
    return sameSite(new URL(a).hostname, new URL(b).hostname);
  } catch { return false; }
}

/** switch only for real India postings that the current page lacks. */
export function pass3Decision({ oldIndia, candidate }) {
  if (!candidate) return 'none-found';
  const n = candidate.india ?? (candidate.indiaMentions > 0 && PASSING.has(candidate.verdict) ? 1 : 0);
  return n > (Number(oldIndia) || 0) ? 'switch' : 'keep';
}
