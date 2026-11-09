// lib/board-backoff.mjs: decide which boards scan.mjs leaves alone, and which hosts it slows down.
//
// The history is data/portal-health.tsv (timestamp, company, status), appended by every scan.
//
// Dead boards (slug_gone, a 404/410). One 404 can be transient, so a board is only held
// after TWO slug_gone results in a row at least 24 hours apart. Held boards are skipped until
// `deadRetryDays` (default 30) have passed since the last check, then tried again.
//
// Rate limits (rate_limited, a 429). A 429 usually means the host is throttling this scanner,
// not that one board is bad, so no board is held for it. Instead `hostsToThrottle` names the
// hosts that answered 429 recently, and scan.mjs fetches those with one request at a time
// and a pause between requests.
//
// Anything else (network, timeout, server, auth, unknown, empty, reachable) is never held:
// a timeout is retried on the very next run.
//
// Pure functions only: the caller passes the records and the clock.

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export const DEFAULT_BACKOFF = Object.freeze({
  deadRetryDays: 30,
  deadStrikeGapHours: 24,
  throttleWindowHours: 48,
});

function sortedByTime(records) {
  return records
    .filter((r) => r && r.company && !Number.isNaN(Date.parse(r.timestamp)))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

/**
 * @param {Array<{timestamp: string, company: string, status: string}>} records any order
 * @param {{now?: Date, deadRetryDays?: number, deadStrikeGapHours?: number}} [options]
 * @returns {Map<string, {reason: 'dead', retryAfter: string}>} company -> hold
 */
export function boardsToSkip(records, options = {}) {
  const { now = new Date(), deadRetryDays, deadStrikeGapHours } = { ...DEFAULT_BACKOFF, ...options };
  const byCompany = new Map();
  for (const r of sortedByTime(records)) {
    if (!byCompany.has(r.company)) byCompany.set(r.company, []);
    byCompany.get(r.company).push(r);
  }

  const holds = new Map();
  for (const [company, rows] of byCompany) {
    // The trailing run of slug_gone results.
    let start = rows.length;
    while (start > 0 && rows[start - 1].status === 'slug_gone') start--;
    const run = rows.slice(start);
    if (run.length < 2) continue;
    const firstMs = Date.parse(run[0].timestamp);
    const lastMs = Date.parse(run[run.length - 1].timestamp);
    if (lastMs - firstMs < deadStrikeGapHours * HOUR_MS) continue; // two strikes the same day count as one
    const retryMs = lastMs + deadRetryDays * DAY_MS;
    if (now.getTime() < retryMs) holds.set(company, { reason: 'dead', retryAfter: new Date(retryMs).toISOString() });
  }
  return holds;
}

/**
 * Hosts that answered 429 for any of their boards within the window.
 * @param {Array<{timestamp: string, company: string, status: string}>} records
 * @param {(company: string) => string | undefined} hostOf host a company's board is fetched from
 * @param {{now?: Date, throttleWindowHours?: number}} [options]
 * @returns {Set<string>}
 */
export function hostsToThrottle(records, hostOf, options = {}) {
  const { now = new Date(), throttleWindowHours } = { ...DEFAULT_BACKOFF, ...options };
  const cutoff = now.getTime() - throttleWindowHours * HOUR_MS;
  const hosts = new Set();
  for (const r of records) {
    if (!r || r.status !== 'rate_limited') continue;
    const t = Date.parse(r.timestamp);
    if (Number.isNaN(t) || t < cutoff) continue;
    const host = hostOf(r.company);
    if (host) hosts.add(host);
  }
  return hosts;
}
