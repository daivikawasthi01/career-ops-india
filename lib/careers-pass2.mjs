// lib/careers-pass2.mjs: pure rules for the second pass over discovered careers pages. No network, no browser.
import { sameSite, registrable } from './careers-pipeline.mjs';

/** Best verdict first. A company's final verdict is the best one among everything tried. */
export const VERDICT_RANK = ['jobs-found', 'listings-on-page', 'board-empty', 'listings-unread', 'landing', 'bot-blocked', 'unverified-identity', 'dead-board', 'unreachable', 'not-careers'];
/** Verdicts that end the repair loop. listings-unread: a careers-looking page on the right site whose listings we could not read (client-side). */
export const PASSING = new Set(['jobs-found', 'listings-on-page', 'listings-unread']);
export const CAREERS_PATH = /career|jobs?\b|open-position|opening|vacanc|join|work-with|hiring/i;
export const best = (verdicts) => [...verdicts].sort((a, b) => VERDICT_RANK.indexOf(a) - VERDICT_RANK.indexOf(b))[0] || 'not-careers';

const JOB_WORDS = /\b(open (positions?|roles?)|current (openings?|vacancies)|job openings?|we(?:'| a)re hiring|join (us|our team)|apply now|view (all )?jobs|search jobs|careers?|vacanc(y|ies)|openings?)\b/i;
const EMPTY_PHRASES = /\b(no (open|current|available) (positions?|roles?|openings?|vacancies|jobs)|there are no (open|current) |currently no (open )?(positions?|roles?|openings?|vacancies)|no jobs? (found|available|match)|0 (open )?(jobs?|positions?|roles?)|check back (later|soon)|not hiring right now|no openings)\b/i;
const TITLE_WORDS = /\b(engineer|developer|sde|analyst|manager|designer|scientist|intern(ship)?|associate|consultant|architect|specialist|executive|lead|director|trainee|devops|qa|tester)\b/i;
const JOB_HREF = /(\/jobs?\/|\/job-|\/positions?\/|\/openings?\/|\/vacanc|\/requisition|\/role[s]?\/|[?&](job|gh_jid|jid|req)[=_]|\/apply\b|\/o\/|\/careers\/[^/]+\/[^/]+)/i;
const FOLLOW_TEXT = /\b(open (positions?|roles?)|current (openings?|vacancies)|view (all )?(jobs|openings|roles|positions)|search (jobs|roles)|see (all )?(jobs|roles|openings)|explore (jobs|roles|careers)|all (jobs|openings|positions)|job (search|listings?))\b/i;
const NOT_FOUND = /\b(page not found|404|could not find what you are looking for|we can'?t find (that|the) page|this page (doesn'?t|does not) exist|no longer exists)\b/i;
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
  if (NOT_FOUND.test(String(text).slice(0, 600))) return { verdict: 'not-careers', note: 'page says not found' }; // a soft 404 keeps the site menu, whose links look like listings
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

// ---- page data: job arrays inside JSON responses ----
export const INDIA_RE = /\b(india|bengaluru|bangalore|bengalooru|blr|hyderabad|pune|mumbai|bombay|delhi|ncr|gurgaon|gurugram|noida|greater noida|chennai|kolkata|ahmedabad|kochi|cochin|jaipur|indore|coimbatore|chandigarh|mohali|trivandrum|thiruvananthapuram|bhubaneswar|nagpur|lucknow|vadodara|visakhapatnam|mysuru|mysore)\b/i;
const IN_CODE = /(?:^|[,\-(|/]\s*)IN(?:\s*[,)|/-]|$)/; // "Hybrid, IN" and "IN-KA": the bare country code, upper case only
export const isIndiaLoc = (s) => INDIA_RE.test(String(s || '')) || IN_CODE.test(String(s || ''));
const TITLE_KEYS = /^(title|job_?title|jobtitle|position|posting_?title|name|requisition_?title|text)$/i;
const LOC_KEYS = /(location|city|country|office|locations)/i;
const JOB_ONLY_KEYS = /(department|employment_?type|job_?type|requisition|req_?id|job_?id|posting|commitment|workplace|posted_?(at|on|date)|apply_?url|team)/i;
const ID_KEYS = /^(id|job_?id|req_?id|requisition_?id|url|apply_?url|absolute_?url|hosted_?url|slug|external_?path)$/i;

/** Find arrays of job-like objects inside parsed JSON (depth-limited). A job-like object has a title-ish key plus a location or id/url key. */
export function jobsFromJson(root) {
  let best = null;
  const walk = (node, depth) => {
    if (depth > 6 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      const objs = node.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
      const jobs = objs.filter((o) => Object.keys(o).some((k) => TITLE_KEYS.test(k) && typeof o[k] === 'string' && o[k].length >= 4) && Object.keys(o).some((k) => LOC_KEYS.test(k) || ID_KEYS.test(k)));
      const titleOf = (o) => String(o[Object.keys(o).find((k) => TITLE_KEYS.test(k) && typeof o[k] === 'string')] || '');
      // A menu, a product list or a blog feed has the same shape as a job list; real jobs read like job titles or carry job-only fields.
      const looksLikeJobs = jobs.filter((o) => TITLE_WORDS.test(titleOf(o))).length >= jobs.length * 0.4 || jobs.filter((o) => Object.keys(o).some((k) => JOB_ONLY_KEYS.test(k))).length >= jobs.length * 0.6;
      if (jobs.length >= 3 && jobs.length >= objs.length * 0.6 && looksLikeJobs && (!best || jobs.length > best.count)) {
        const title = titleOf;
        const loc = (o) => Object.keys(o).filter((k) => LOC_KEYS.test(k)).map((k) => (typeof o[k] === 'string' ? o[k] : JSON.stringify(o[k]) || '')).join(' ');
        best = { count: jobs.length, located: jobs.filter((o) => loc(o).trim().length > 1).length, india: jobs.filter((o) => isIndiaLoc(loc(o))).length, sample: jobs.slice(0, 5).map(title) };
      }
      for (const x of node.slice(0, 50)) walk(x, depth + 1);
    } else for (const v of Object.values(node)) walk(v, depth + 1);
  };
  walk(root, 0);
  return best;
}
export const bestJsonJobs = (list = []) => list.filter(Boolean).sort((a, b) => b.count - a.count)[0] || null;

// ---- identity: a pass needs the page to be the company's ----
const toks = (name) => String(name).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
export const nameInHost = (url, name) => { let h = ''; try { h = new URL(url).hostname.toLowerCase().replace(/[^a-z0-9]/g, ''); } catch { return false; } return toks(name).some((t) => h.includes(t)); };
/** Trusted keys: hosts and ATS tenants the company is known to own (for example from an accepted pass 1 row). */
export const keyOf = (url, atsOf) => { try { const a = atsOf(url); return a ? `${a.ats}/${String(a.tenant || '').split('/')[0].toLowerCase()}` : registrable(new URL(url).hostname); } catch { return ''; } };
export function identityOk(url, name, trusted, atsOf, slugMatches) {
  const key = keyOf(url, atsOf);
  if (key && trusted.has(key)) return true;
  const a = atsOf(url);
  const flat = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  // A short or common-word name ("Arc", "Porter") matches too many boards by prefix: only an exact slug counts.
  const short = flat(name).length <= 5;
  if (a) { const slug = String(a.tenant || '').split('/')[0]; return short ? flat(slug) === flat(name) : Boolean(slugMatches && slugMatches(slug, name)); }
  if (short) { let h = ''; try { h = new URL(url).hostname.toLowerCase(); } catch { return false; } const parts = h.replace(/^www\./, '').split('.'); return parts.some((p) => p === flat(name)); }
  return nameInHost(url, name);
}

// ---- location-filter links on a listing page ----
/** Links that look like an India filter: an India word in the link text or in a location-like query value or path. */
export function indiaFilterLinks(links = [], pageHost = '') {
  const out = [];
  for (const l of links) {
    let u; try { u = new URL(l.href); } catch { continue; }
    if (pageHost && !sameSite(u.hostname, pageHost)) continue;
    const q = [...u.searchParams].some(([k, v]) => /country|location|region|city|loc/i.test(k) && /(india|^in$|^ind$|bengaluru|bangalore|hyderabad|pune|mumbai|delhi|chennai)/i.test(v));
    const p = /\/(india|in|en-in)(\/|$)/i.test(u.pathname) && /career|job|search|opening/i.test(u.pathname + u.search);
    const t = isIndiaLoc(l.text || '') && String(l.text || '').length < 60 && /career|job|search|opening|location|office|explore|view/i.test(`${u.pathname} ${u.search} ${l.text}`);
    if (q || p || t) out.push(l);
  }
  return out.filter((l, i, a) => a.findIndex((x) => x.href === l.href) === i).slice(0, 3);
}

/**
 * Final status for a portal that passed. Jobs were read AND their locations were read: zero in India is right-portal-no-india.
 * Jobs were read but no locations (page text, thin JSON): india-unknown, a person or a later pass decides. No jobs read: unchanged.
 */
export function indiaStatus(top, win) {
  if (top !== 'jobs-found' && top !== 'listings-on-page') return top;
  const located = win?.located ?? (top === 'jobs-found' ? win?.total : 0);
  if (!located) return 'india-unknown';
  return Number(win?.india) === 0 ? 'right-portal-no-india' : top;
}

/** URLs worth trying when search found nothing: the usual careers spots on a host we already trust. */
export function guessCareerUrls(host = '') {
  const h = String(host).toLowerCase().replace(/^www\./, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)) return [];
  return [`https://careers.${h}`, `https://www.${h}/careers`, `https://www.${h}/career`, `https://jobs.${h}`, `https://www.${h}/jobs`, `https://www.${h}/careers.html`, `https://www.${h}/about-us/careers`, `https://www.${h}/join-us`, `https://www.${h}/careers/india`];
}

/**
 * Sibling India boards on the same ATS: razorpay -> razorpayindia, razorpay-india, razorpayin.
 * Only the tenant changes (first path segment, or the first host label for host-based ATS), so the result stays on the same ATS.
 */
export function indiaTenantVariants(url, atsOf) {
  try {
    const a = atsOf(url); if (!a?.tenant) return [];
    const tenant = String(a.tenant).split('/')[0]; const u = new URL(url);
    const swap = (t) => {
      const v = new URL(url);
      const seg = v.pathname.split('/');
      const i = seg.findIndex((x) => x.toLowerCase() === tenant.toLowerCase());
      if (i >= 0) { seg[i] = t; v.pathname = seg.join('/'); return v.toString(); }
      const labels = v.hostname.split('.');
      if (labels[0].toLowerCase() === tenant.toLowerCase()) { labels[0] = t; v.hostname = labels.join('.'); return v.toString(); }
      return null;
    };
    return [`${tenant}india`, `${tenant}-india`, `${tenant}in`].map(swap).filter((x) => x && x !== url && u.href);
  } catch { return []; }
}

/** Same ATS, and the other tenant is the old one plus a suffix (a sibling board such as an India entity). */
export function siblingTenant(a, b, atsOf) {
  try {
    const x = atsOf(a); const y = atsOf(b);
    if (!x || !y || x.ats !== y.ats) return false;
    const tx = String(x.tenant).split('/')[0].toLowerCase(); const ty = String(y.tenant).split('/')[0].toLowerCase();
    return tx !== ty && ty.startsWith(tx) && /^[-_]?(india|in|ind)$/.test(ty.slice(tx.length));
  } catch { return false; }
}
