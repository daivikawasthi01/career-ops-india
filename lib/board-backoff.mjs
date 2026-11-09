// lib/board-backoff.mjs: decide which boards scan.mjs should leave alone this run.
//
// The history is data/portal-health.tsv (timestamp, company, status), appended by every
// scan. The rules, by the latest status a board has:
//
//   slug_gone     the board is gone (404/410). Cached as dead: skipped until
//                 `deadRetryDays` (default 30) have passed since the last check, then tried again.
//   rate_limited  the host answered 429. Back off: wait base * 2^(n-1) hours, where n is
//                 how many 429s in a row (default 24h, 48h, 96h ... capped at maxRateLimitDays).
//   anything else (network, timeout, server, auth, unknown, empty, reachable): never skipped.
//                 A timeout or network error is retried on the very next run.
//
// Pure functions only: the caller passes the records and the clock.

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export const DEFAULT_BACKOFF = Object.freeze({
  deadRetryDays: 30,
  rateLimitBaseHours: 24,
  maxRateLimitDays: 7,
});

/**
 * @param {Array<{timestamp: string, company: string, status: string}>} records oldest first
 * @param {{now?: Date, deadRetryDays?: number, rateLimitBaseHours?: number, maxRateLimitDays?: number}} [options]
 * @returns {Map<string, {reason: 'dead' | 'rate_limited', retryAfter: string}>} company -> hold
 */
export function boardsToSkip(records, options = {}) {
  const { now = new Date(), deadRetryDays, rateLimitBaseHours, maxRateLimitDays } = { ...DEFAULT_BACKOFF, ...options };
  const byCompany = new Map();
  for (const r of records) {
    if (!r || !r.company) continue;
    if (!byCompany.has(r.company)) byCompany.set(r.company, []);
    byCompany.get(r.company).push(r);
  }

  const holds = new Map();
  for (const [company, rows] of byCompany) {
    const last = rows[rows.length - 1];
    const lastMs = Date.parse(last.timestamp);
    if (Number.isNaN(lastMs)) continue;

    if (last.status === 'slug_gone') {
      const retryMs = lastMs + deadRetryDays * DAY_MS;
      if (now.getTime() < retryMs) holds.set(company, { reason: 'dead', retryAfter: new Date(retryMs).toISOString() });
    } else if (last.status === 'rate_limited') {
      let streak = 0;
      for (let i = rows.length - 1; i >= 0 && rows[i].status === 'rate_limited'; i--) streak++;
      const waitMs = Math.min(rateLimitBaseHours * HOUR_MS * 2 ** (streak - 1), maxRateLimitDays * DAY_MS);
      const retryMs = lastMs + waitMs;
      if (now.getTime() < retryMs) holds.set(company, { reason: 'rate_limited', retryAfter: new Date(retryMs).toISOString() });
    }
  }
  return holds;
}
