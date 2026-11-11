// Reads the years of experience a list of postings asks for, with career-ops' own jd-years.mjs (rules only, no model, no tokens).
//   stdin:  [{"id": "...", "url": "..."}, ...]
//   stdout: one JSON line per posting as it finishes: {id, state, status, min, confident, display}
// state: "read" (the posting's JD was read), "nohost" (no public JD API for that host: nothing to read), "unread" (the request failed; retry later).
import { fetchJdText, parseYearsRequirement } from '../../../jd-years.mjs';
import { makeHttpCtx } from '../../../providers/_http.mjs';

const input = await new Promise((resolve) => { let s = ''; process.stdin.on('data', (d) => (s += d)); process.stdin.on('end', () => resolve(s)); });
const jobs = JSON.parse(input || '[]');
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.YEARS_CONCURRENCY || 4)));
const boardCache = new Map();   // Ashby's API is a whole board: one request serves every posting on it
const ctx = makeHttpCtx();
let next = 0;

async function one({ id, url }) {
  try {
    const text = await fetchJdText(url, { boardCache, ctx });
    if (text === null) return { id, state: 'nohost' };
    const req = parseYearsRequirement(text);
    return { id, state: 'read', status: req.status, min: req.min, confident: !!req.confident, display: req.display || '' };
  } catch (e) {
    return { id, state: 'unread', error: String(e.message || e).slice(0, 120) };
  }
}
async function worker() {
  while (next < jobs.length) {
    const job = jobs[next++];
    process.stdout.write(JSON.stringify(await one(job)) + '\n');
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
