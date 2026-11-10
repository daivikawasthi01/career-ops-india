import test from 'node:test';
import assert from 'node:assert/strict';
import yc, { parseListing, listingUrls, agoToMs } from '../../providers/yc.mjs';

const page = (rows) => `<div data-page="${JSON.stringify({ props: { jobPostings: rows } }).replace(/"/g, '&quot;')}"></div>`;

test('parses rows, drops malformed ones, builds absolute urls', () => {
  const jobs = parseListing(page([
    { id: 1, title: 'Software Engineer', url: '/companies/acme/jobs/abc-se', companyName: 'Acme', location: 'Bengaluru, India', createdAt: '3 days', type: 'Full-time', companyBatchName: 'W20' },
    { id: 2, title: '', url: '/companies/x/jobs/y' },
    { id: 3, title: 'Bad url', url: 'https://evil.example/x' },
    null,
  ]));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].url, 'https://www.ycombinator.com/companies/acme/jobs/abc-se');
  assert.equal(jobs[0].company, 'Acme');
  assert.ok(jobs[0].postedAt < Date.now());
});

test('fails loudly when the payload changes', () => {
  assert.throws(() => parseListing('<html></html>'), /no data-page/);
  assert.throws(() => parseListing(`<div data-page="${JSON.stringify({ props: {} }).replace(/"/g, '&quot;')}"></div>`), /jobPostings/);
});

test('listing urls and relative time', () => {
  assert.deepEqual(listingUrls({}), ['https://www.ycombinator.com/jobs/role/software-engineer/india', 'https://www.ycombinator.com/jobs/role/software-engineer/remote']);
  assert.deepEqual(listingUrls({ roles: ['../x'] }), listingUrls({}));
  assert.equal(agoToMs('2 hours', 10 * 36e5), 8 * 36e5);
  assert.equal(agoToMs('whenever'), undefined);
  assert.equal(yc.detect({}), null);
});
