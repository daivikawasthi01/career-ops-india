import { test } from 'node:test';
import assert from 'node:assert/strict';
import unstop, { parseUnstopPage, jobLocation, resolveKind, resolveMaxPages } from '../../providers/unstop.mjs';

const row = (o = {}) => ({ id: 7, title: ' SDE  Intern ', seo_url: 'https://unstop.com/internships/sde-intern-acme-7', status: 'LIVE', regn_open: 1,
  organisation: { name: 'Acme' }, locations: [{ city: 'Pune', state: 'Maharashtra', country: 'India' }], jobDetail: { type: 'in_office' },
  details: '<p>Build things</p>', approved_date: '2026-11-10 09:20:24 GMT+0530', ...o });

test('parses a live row into the normalized job shape', () => {
  const { jobs, lastPage } = parseUnstopPage({ data: { last_page: 3, data: [row()] } });
  assert.equal(lastPage, 3);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'SDE Intern');
  assert.equal(jobs[0].company, 'Acme');
  assert.equal(jobs[0].location, 'Pune, Maharashtra, India');
  assert.equal(jobs[0].postedAt, Date.parse('2026-11-10T09:20:24+05:30'));
  assert.match(jobs[0].description, /Build things/);
});
test('drops closed, off-host and untitled rows; keeps the rest', () => {
  const { jobs } = parseUnstopPage({ data: { data: [row({ status: 'CLOSED' }), row({ regn_open: 0 }), row({ seo_url: 'https://evil.example/x' }), row({ title: '' }), null, row({ id: 8 })] } });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].externalId, '8');
});
test('an unexpected envelope throws instead of reading as empty', () => {
  assert.throws(() => parseUnstopPage({ message: 'x' }), /unexpected response/);
  assert.throws(() => parseUnstopPage(null), /unexpected response/);
});
test('location falls back to jobDetail cities, Remote, then India', () => {
  assert.equal(jobLocation({ locations: [], jobDetail: { locations: ['Delhi'] } }), 'Delhi');
  assert.equal(jobLocation({ locations: [], jobDetail: { type: 'wfh' } }), 'Remote');
  assert.equal(jobLocation({}), 'India');
});
test('options are clamped', () => {
  assert.equal(resolveKind({ opportunity: 'Internships' }), 'internships');
  assert.equal(resolveKind({ opportunity: 'x' }), 'jobs');
  assert.equal(resolveMaxPages({ maxPages: 9999 }), 100);
  assert.equal(resolveMaxPages({}), 30);
  assert.equal(unstop.detect({ careers_url: 'https://unstop.com/jobs' }), null);
});
