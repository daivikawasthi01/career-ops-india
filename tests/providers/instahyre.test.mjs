import { test } from 'node:test';
import assert from 'node:assert/strict';
import p, { parseInstahyrePage, resolveOptions, cityList } from '../../providers/instahyre.mjs';

const row = (o = {}) => ({ id: 5, title: 'SDE Intern', locations: 'Gurgaon,Bangalore', public_url: 'https://www.instahyre.com/job-5-sde-intern-at-acme/', employer: { company_name: 'Acme' }, keywords: ['python', 'sql'], ...o });
const page = (rows, next = '/api/v1/job_search?offset=35') => ({ objects: rows, meta: { total_count: rows.length, next } });

test('parses rows into jobs and reports paging', () => {
  const r = parseInstahyrePage(page([row()]));
  assert.equal(r.jobs.length, 1); assert.equal(r.next, true);
  assert.deepEqual([r.jobs[0].company, r.jobs[0].location, r.jobs[0].externalId], ['Acme', 'Gurgaon; Bangalore', '5']);
  assert.match(r.jobs[0].description, /python/);
  assert.equal(parseInstahyrePage(page([row()], null)).next, false);
});
test('city filter keeps rows with any listed city; NCR expands', () => {
  const rows = page([row(), row({ id: 6, locations: 'Pune', public_url: 'https://www.instahyre.com/job-6-x/' })]);
  assert.equal(parseInstahyrePage(rows, resolveOptions({ cities: ['NCR'] }).cities).jobs.length, 1);
  assert.equal(parseInstahyrePage(rows, []).jobs.length, 2);
});
test('drops off-host or id-less rows; throws on a changed envelope', () => {
  assert.equal(parseInstahyrePage(page([row({ public_url: 'https://evil.example/x' }), row({ id: null }), null])).jobs.length, 0);
  assert.throws(() => parseInstahyrePage({ results: [] }), /unexpected response/);
  assert.throws(() => parseInstahyrePage(null), /unexpected response/);
});
test('options are clamped and sanitised', () => {
  assert.deepEqual(resolveOptions({}), { years: 0, skills: '', cities: [], maxPages: 25, newest: 100 });
  assert.equal(resolveOptions({ years: 'any' }).years, null);
  assert.equal(resolveOptions({ years: 99 }).years, 0);
  assert.equal(resolveOptions({ skills: 'Py thon;<x>' }).skills, 'py thonx');
  assert.equal(resolveOptions({ maxPages: 9999 }).maxPages, 60);
  assert.deepEqual(cityList({ locations: 'A, B,,C' }), ['A', 'B', 'C']);
  assert.equal(p.detect({}), null);
});

test('newest limits the rows kept: the feed has no dates, so the highest ids are the recency limit', () => {
  assert.equal(resolveOptions({ newest: 40 }).newest, 40);
  assert.equal(resolveOptions({ newest: 0 }).newest, 100);
  assert.equal(resolveOptions({ newest: 'x' }).newest, 100);
});
