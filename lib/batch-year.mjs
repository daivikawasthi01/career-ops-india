// lib/batch-year.mjs: which graduation batches a posting names.
// Pure; used by every scanner and by the golden title test.

const YEAR = '(20(?:2[3-9]|3[0-2]))';
const CONTEXT = '(?:batch|pass(?:ed)?[\\s-]?outs?|passing\\s+out|graduat\\w*|class\\s+of|grads?|joining|b\\.?\\s?tech|be\\b|mca|bca)';
const NEAR = new RegExp(`${CONTEXT}\\W+(?:\\w+\\W+){0,4}?${YEAR}|${YEAR}\\W+(?:\\w+\\W+){0,3}?${CONTEXT}`, 'gi');

/**
 * Batch years a posting asks for, found only next to batch-like words so a
 * founding year or a copyright line is not read as a requirement.
 */
export function batchYears(text) {
  const years = new Set();
  for (const m of String(text || '').matchAll(NEAR)) {
    // Every year inside the span: "2026 and 2027 batch" names both, not only the first.
    for (const y of m[0].matchAll(new RegExp(YEAR, 'g'))) years.add(y[1]);
  }
  return [...years];
}

/**
 * Keep when no batch year is named, or the target year is among them.
 * "2025 or 2026 or 2027 batch" is kept; "2025 batch only" is dropped.
 */
export function yearOk(text, target) {
  const accepted = (Array.isArray(target) ? target : [target]).map(String);
  const years = batchYears(text);
  return years.length === 0 || years.some((y) => accepted.includes(y));
}

