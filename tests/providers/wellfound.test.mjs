import { test } from 'node:test';
import assert from 'node:assert/strict';
import p, { extractApollo, parseListings, resolveOptions, roleUrl } from '../../providers/wellfound.mjs';

const data = {
  'JobListingSearchResult:1': { id: '1', title: 'Software Engineer', slug: 'software-engineer', yearsExperienceMin: 1, liveStartAt: 1793169764, locationNames: ['Bengaluru', 'Bengaluru', 'Dubai'], compensation: '$40k', jobType: 'full-time' },
  'JobListingSearchResult:2': { id: '2', title: 'Staff Engineer', slug: 'staff-engineer', yearsExperienceMin: 8 },
  'JobListingSearchResult:3': { id: '3', title: 'No years', slug: 'no-years', yearsExperienceMin: null, remote: true },
  'JobListingSearchResult:4': { id: 'x', title: 'Bad id', slug: 'bad' },
  'StartupResult:9': { name: 'Fuze', highlightedJobListings: [{ __ref: 'JobListingSearchResult:1' }] },
};
const html = (d, title = 'Software Engineer Jobs') => `<html><title>${title}</title><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { apolloState: { data: d } } } })}</script></html>`;

test('listings become jobs with company, date, places and the experience filter', () => {
  const jobs = parseListings(data);
  assert.deepEqual(jobs.map((j) => j.externalId), ['1', '3']);
  assert.equal(jobs[0].url, 'https://wellfound.com/jobs/1-software-engineer'); assert.equal(jobs[0].company, 'Fuze');
  assert.equal(jobs[0].location, 'Bengaluru; Dubai'); assert.equal(jobs[0].postedAt, 1793169764000);
  assert.match(jobs[0].description, /\$40k\. Experience: 1\+ years/); assert.equal(jobs[1].location, 'Remote');
  assert.equal(parseListings(data, { maxYears: 10 }).length, 3);
});
test('a block page or changed layout throws instead of reading as empty', () => {
  assert.throws(() => extractApollo(html(data, 'Security Check | Wellfound')), /bot check/);
  assert.throws(() => extractApollo('<html><title>x</title></html>'), /__NEXT_DATA__/);
  assert.throws(() => extractApollo(`<title>x</title><script id="__NEXT_DATA__">{"props":{"pageProps":{}}}</script>`), /apolloState/);
  assert.equal(Object.keys(extractApollo(html(data))).length, 5);
});
test('options are sanitised and urls built', () => {
  assert.deepEqual(resolveOptions({ roles: ['Backend-Engineer', '../x', 'backend-engineer'], pages: 99, maxYears: 'a' }), { roles: ['backend-engineer'], pages: 5, maxYears: 2 });
  assert.equal(resolveOptions({}).roles.length, 6);
  assert.equal(roleUrl('x', 1), 'https://wellfound.com/role/l/x/india'); assert.equal(roleUrl('x', 2), 'https://wellfound.com/role/l/x/india?page=2');
  assert.equal(p.detect({}), null);
});
test('fetch dedups across roles, skips a redirected role, and keeps results when blocked midway', async () => {
  const calls = [];
  const ctx = { sleep: async () => {}, fetchText: async (url) => { calls.push(url); if (url.includes('devops')) throw new Error('HTTP 303'); return html(data); } };
  const jobs = await p.fetch({ roles: ['software-engineer', 'devops-engineer', 'backend-engineer'], pages: 1 }, ctx);
  assert.deepEqual(jobs.map((j) => j.externalId), ['1', '3']); assert.equal(calls.length, 3);
  let n = 0;
  const blocking = { sleep: async () => {}, fetchText: async () => (++n === 1 ? html(data) : html(data, 'Security Check | Wellfound')) };
  assert.equal((await p.fetch({ roles: ['a', 'b'], pages: 1 }, blocking)).length, 2);
  await assert.rejects(p.fetch({ roles: ['a'], pages: 1 }, { sleep: async () => {}, fetchText: async () => html(data, 'Security Check | Wellfound') }), /bot check/);
});
