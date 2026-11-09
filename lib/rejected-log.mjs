// lib/rejected-log.mjs: remember every posting a scanner dropped, and why, for 30 days.
// A filter that drops silently cannot be audited; this file is what tools/rejected_sample.py
// samples so false negatives can be spotted. Tab-separated, one row per rejection.
// (Phase 4 moves this into the SQLite store; the columns stay the same.)

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { dirname } from 'path';

export const REJECTED_HEADER = 'timestamp\tsource\tcompany\ttitle\turl\treason';
const DAY_MS = 86_400_000;
const clean = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();

/** Rows newer than `days`, header excluded. Pure. */
export function pruneRejected(lines, { now = new Date(), days = 30 } = {}) {
  const cutoff = now.getTime() - days * DAY_MS;
  return lines.filter((l) => {
    const t = Date.parse(l.split('\t')[0]);
    return !Number.isNaN(t) && t >= cutoff;
  });
}

/**
 * @param {string} path rejected.tsv
 * @param {{days?: number, now?: Date}} [options]
 */
export function createRejectedLog(path, { days = 30, now = new Date() } = {}) {
  const rows = [];
  return {
    /** Remember one dropped posting. `reason` is a short code such as title_filter or batch_year. */
    add(offer, reason) {
      rows.push([now.toISOString(), offer.source, offer.company, offer.title, offer.url, reason].map(clean).join('\t'));
    },
    get count() { return rows.length; },
    /** Append this run's rows and drop anything older than `days`. Skip entirely on a dry run. */
    flush() {
      if (!rows.length) return 0;
      mkdirSync(dirname(path), { recursive: true });
      const existing = existsSync(path) ? readFileSync(path, 'utf-8').split('\n').slice(1).filter(Boolean) : [];
      const kept = pruneRejected(existing, { now, days });
      if (kept.length !== existing.length || !existsSync(path)) {
        writeFileSync(path, [REJECTED_HEADER, ...kept, ...rows].join('\n') + '\n');
      } else {
        appendFileSync(path, rows.join('\n') + '\n');
      }
      return rows.length;
    },
  };
}
