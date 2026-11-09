// lib/board-identity-names.mjs: does a board's owner name refer to the company we tracked?
//
// Boards title themselves loosely: "Bolna AI" for Bolna, "HackerRank Careers" for HackerRank,
// "Careers at Tide" for TIDE. Words that only describe a careers page or a legal form carry no
// identity, so they are dropped before comparing. Words that describe WHAT the company is
// ("Research", "Systems", "Airlines") are kept: they are what separates SAIL from Sail Research.
//
// Pure: no network, no file access.

import { asciiFold } from './ascii-fold.mjs';

/** Careers-page wording and legal-form wording. Nothing here names a business. */
export const NOISE_TOKENS = new Set([
  'careers', 'career', 'jobs', 'job', 'hiring', 'at', 'the', 'official',
  'technologies', 'technology', 'tech', 'ai', 'labs', 'lab', 'hq', 'group',
  'inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'plc', 'corp', 'corporation',
  'co', 'company', 'pvt', 'private', 'gmbh', 'ag', 'sa', 'sas', 'bv', 'pty', 'pte',
]);

/** Lowercase, accent-folded tokens with ampersands read as "and" and in-word punctuation removed. */
export function rawTokens(name) {
  const spaced = String(name || '').replace(/\s+/g, ' ').replace(/\s+&\s+/g, ' and ');
  return asciiFold(spaced, { punctuation: 'delete' }).split(' ').filter(Boolean);
}

/** Identity tokens: raw tokens minus noise. A name made only of noise ("AI Inc") keeps its tokens. */
export function identityTokens(name) {
  const raw = rawTokens(name);
  const kept = raw.filter((t) => !NOISE_TOKENS.has(t));
  return kept.length ? kept : raw;
}

/**
 * @returns {{match: boolean, how: 'exact'|'normalized'|'none'}}
 * `exact`: the folded names are identical. `normalized`: identical once noise words are dropped,
 * compared by token and by the joined string ("Hacker Rank" = "HackerRank").
 */
export function nameIdentityVerdict(companyName, boardName) {
  const a = rawTokens(companyName);
  const b = rawTokens(boardName);
  if (!a.length || !b.length) return { match: false, how: 'none' };
  if (a.length === b.length && a.every((t, i) => t === b[i])) return { match: true, how: 'exact' };
  const ia = identityTokens(companyName);
  const ib = identityTokens(boardName);
  if (ia.length === ib.length && ia.every((t, i) => t === ib[i])) return { match: true, how: 'normalized' };
  if (ia.join('') === ib.join('')) return { match: true, how: 'normalized' };
  return { match: false, how: 'none' };
}
