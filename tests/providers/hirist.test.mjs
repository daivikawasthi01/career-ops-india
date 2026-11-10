import { test } from 'node:test';
import assert from 'node:assert/strict';
import hirist, { parseCard, postedAgoToMs, resolveOptions, listingUrl } from '../../providers/hirist.mjs';

const href = 'https://www.hirist.tech/j/refyne-data-analyst-finance-domain-1682201?ref=kp_br_prm&jobPos=1';
const text = 'Refyne - Data Analyst - Finance Domain | 2 - 4 yrs | Bangalore/Hyderabad/Chennai | Python | Data Analyst | SQL | +2 | Posted 6 days ago';

test('parseCard splits company, title, experience, cities, skills and age', () => {
  const j = parseCard(href, text, undefined);
  assert.equal(j.company, 'Refyne'); assert.equal(j.title, 'Data Analyst - Finance Domain (2 - 4 yrs)');
  assert.equal(j.location, 'Bangalore; Hyderabad; Chennai'); assert.equal(j.url, 'https://www.hirist.tech/j/refyne-data-analyst-finance-domain-1682201');
  assert.equal(j.externalId, '1682201'); assert.match(j.description, /Python, Data Analyst, SQL/);
  assert.ok(Math.abs(j.postedAt - (Date.now() - 6 * 864e5)) < 5000);
});
test('parseCard rejects off-host links and cards without a job id or title', () => {
  assert.equal(parseCard('https://evil.example/j/x-1234567', text), null);
  assert.equal(parseCard('https://www.hirist.tech/j/', text), null);
  assert.equal(parseCard(href, 'only'), null);
});
test('posted-ago and options', () => {
  const now = 1e12;
  assert.equal(postedAgoToMs('Posted 1 week ago', now), now - 6048e5);
  assert.equal(postedAgoToMs('Posted today', now), now);
  assert.equal(postedAgoToMs('nonsense', now), undefined);
  assert.deepEqual(resolveOptions({ keywords: ['Back End!'], maxexp: 99 }), { keywords: ['back-end'], minexp: 0, maxexp: 2, pages: 2 });
  assert.match(listingUrl('python', { minexp: 0, maxexp: 2 }, 3), /python-jobs\?minexp=0&maxexp=2&page=3/);
});
test('fetch reads cards through the browser, dedups, and fails loudly on an empty first page', async () => {
  const mk = (cards, none = false) => async () => ({ newPage: async () => ({ goto: async () => {}, waitForSelector: async () => {}, evaluate: async () => ({ list: cards, none }), close: async () => {} }), close: async () => {} });
  const ctx = { maxPages: 1 };
  const jobs = await hirist.fetch({ keywords: ['python'] }, ctx, mk([{ href, text }, { href, text }]));
  assert.equal(jobs.length, 1);
  await assert.rejects(hirist.fetch({ keywords: ['python'] }, ctx, mk([])), /no job cards rendered/);
  // Hirist's own "No result found" page means the keyword has no listing: empty, not blocked
  assert.deepEqual(await hirist.fetch({ keywords: ['software-developer'] }, ctx, mk([], true)), []);
});
