// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { BROWSER_LIKE_USER_AGENT, sleep } from './_http.mjs';

// Hirist provider: India tech-hiring board. hirist.tech is a React app: the listing HTML arrives empty and the cards are
// injected in the browser, so this reads the RENDERED page with a headless Chromium (Playwright), like a visitor.
// robots.txt allows it (a crawl delay is stated only for Yandex); this waits 4 s between pages anyway.
//
//   https://www.hirist.tech/k/<keyword>-jobs?minexp=0&maxexp=2&page=1
//   card text: "<Company> - <Title> | 2 - 4 yrs | Bangalore/Hyderabad | skill | skill | +2 | Posted 6 days ago"
//
// A board / aggregator: `provider: hirist`. Rows are UNCONFIRMED until found at the employer; hirist.tech is in
// config/pipeline.yml aggregator_hosts.
//
// Entry fields (all optional):
//   keywords   list of keyword slugs, default [software-developer, python, java, backend-developer, devops]
//   minexp / maxexp   experience window sent to the site, default 0 / 2
//   pages      pages per keyword, default 2, ceiling 5
//
// Fails loudly: a page that renders no job cards on page 1 throws (blocked, or the layout changed) instead of reading as empty.

const BASE = 'https://www.hirist.tech';
const DEFAULT_KEYWORDS = ['python', 'java', 'full-stack', 'golang', 'machine-learning', 'devops']; // slugs Hirist has a listing for; others answer "No result found"
const PAGE_DELAY_MS = 4000;

/** @param {any} entry */
export function resolveOptions(entry) {
  const slug = (k) => String(k).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const kws = (Array.isArray(entry?.keywords) ? entry.keywords : DEFAULT_KEYWORDS).map(slug).filter(Boolean).slice(0, 12);
  const n = (v, d, lo, hi) => (Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : d);
  return { keywords: kws.length ? kws : DEFAULT_KEYWORDS, minexp: n(entry?.minexp, 0, 0, 30), maxexp: n(entry?.maxexp, 2, 0, 40), pages: n(entry?.pages, 2, 1, 5) };
}

export const listingUrl = (kw, o, page) => `${BASE}/k/${kw}-jobs?minexp=${o.minexp}&maxexp=${o.maxexp}&page=${page}`;

/**
 * One rendered card -> job. Exported for tests.
 * @param {string} href  absolute link to /j/<slug>-<id>
 * @param {string} text  card innerText with newlines turned into " | "
 * @returns {import('./_types.js').Job | null}
 */
export function parseCard(href, text) {
  let u; try { u = new URL(href); } catch { return null; }
  const m = /^\/j\/[a-z0-9-]*?-?(\d{5,})$/i.exec(u.pathname);
  if (u.hostname !== 'www.hirist.tech' || !m) return null;
  const parts = String(text).split('|').map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const head = parts[0];
  const dash = head.indexOf(' - ');
  const company = dash > 0 ? head.slice(0, dash).trim() : '';
  const title = (dash > 0 ? head.slice(dash + 3) : head).trim();
  const exp = parts.find((p) => /^\d+\s*[-–]\s*\d+\s*yrs?$|^\d+\s*\+\s*yrs?$/i.test(p)) || '';
  const idx = exp ? parts.indexOf(exp) : 0;
  const location = (parts[idx + 1] || '').split('/').map((c) => c.trim()).filter(Boolean).join('; ');
  const posted = parts.find((p) => /^posted\b/i.test(p)) || '';
  const skills = parts.slice(idx + 2).filter((p) => !/^posted\b/i.test(p) && !/^\+\d+$/.test(p));
  if (!title) return null;
  /** @type {import('./_types.js').Job} */
  const job = { title: exp ? `${title} (${exp})` : title, url: `${BASE}${u.pathname}`, company, location: location || 'India', externalId: m[1] };
  const when = postedAgoToMs(posted);
  if (when) job.postedAt = when;
  if (skills.length) job.description = `Skills: ${skills.slice(0, 15).join(', ')}`;
  return job;
}

/** "Posted 6 days ago" / "Posted 1 week ago" / "Posted today" -> epoch ms (approximate, start of that day). */
export function postedAgoToMs(s, now = Date.now()) {
  const m = /posted\s+(?:(\d+)\s+(hour|day|week|month)s?\s+ago|(today|yesterday)|a\s+(day|week|month)\s+ago)/i.exec(s || '');
  if (!m) return undefined;
  const unit = { hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6 };
  if (m[3]) return now - (m[3].toLowerCase() === 'today' ? 0 : unit.day);
  const n = m[1] ? Number(m[1]) : 1;
  return now - n * unit[(m[2] || m[4]).toLowerCase()];
}

/** @param {() => Promise<any>} [launch] test seam */
async function defaultLaunch() { return (await import('playwright')).chromium.launch({ headless: true }); }

/** @type {Provider} */
export default {
  id: 'hirist',
  detect(_entry) { return null; },
  async fetch(entry, ctx, launch = defaultLaunch) {
    const o = resolveOptions(entry);
    const probing = Number(ctx?.maxPages) > 0;
    const pages = probing ? Math.min(o.pages, Number(ctx.maxPages)) : o.pages;
    const keywords = probing ? o.keywords.slice(0, 1) : o.keywords;
    const browser = await launch();
    const out = []; const seen = new Set();
    try {
      for (const kw of keywords) {
        for (let page = 1; page <= pages; page++) {
          const pg = await browser.newPage({ userAgent: BROWSER_LIKE_USER_AGENT });
          let cards;
          try {
            // The site keeps connections open, so a load event may never fire; cards appearing is the real signal.
            await pg.goto(listingUrl(kw, o, page), { waitUntil: 'commit', timeout: 30000 }).catch(() => {});
            await pg.waitForSelector('a[href*="/j/"]', { timeout: 30000 }).catch(() => {});
            const read = () => pg.evaluate(() => ({ list: [...document.querySelectorAll('a[href*="/j/"]')].map((a) => ({ href: a.href, text: a.innerText.replace(/\n+/g, ' | ') })), none: /no result found/i.test(document.body.innerText) }));
            for (let attempt = 0; ; attempt++) { // the SPA may navigate once after the first cards show; read again when the context is replaced
              try { const r = await read(); cards = r.list; cards.none = r.none; break; }
              catch (e) {
                if (attempt >= 3 || !/context was destroyed|navigation/i.test(String(e?.message))) throw e;
                await pg.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
                await pg.waitForSelector('a[href*="/j/"]', { timeout: 15000 }).catch(() => {});
              }
            }
          } catch (err) {
            if (page === 1 && !out.length) throw new Error(`hirist: could not load ${kw} listing: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
            break;
          } finally { await pg.close().catch(() => {}); }
          if (!cards.length) { if (cards.none) break; /* Hirist has no listing for this keyword: not a block */ if (page === 1 && !out.length) throw new Error(`hirist: no job cards rendered for "${kw}" (blocked, or the layout changed)`); break; }
          for (const c of cards) { const j = parseCard(c.href, c.text); if (j && !seen.has(j.url)) { seen.add(j.url); out.push(j); } }
          await sleep(PAGE_DELAY_MS, ctx);
        }
      }
    } finally { await browser.close().catch(() => {}); }
    return out;
  },
};
