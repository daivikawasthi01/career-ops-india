import test from 'node:test';
import assert from 'node:assert/strict';

test('postedFromDaysAgo turns "N days ago" into a date so the age can be checked', async () => {
  const { postedFromDaysAgo, toOffer } = await import('../scan-internshala.mjs');
  const now = Date.parse('2026-11-10T12:00:00Z');
  assert.equal(postedFromDaysAgo(0, now), '2026-11-10');
  assert.equal(postedFromDaysAgo(3, now), '2026-11-07');
  assert.equal(postedFromDaysAgo(undefined, now), undefined);
  assert.equal(postedFromDaysAgo(-1, now), undefined);
  assert.equal(toOffer({ link: 'https://x', title: 'T', posted: { date: '2026-11-01' } }, 'job').postedAt, '2026-11-01');
});
