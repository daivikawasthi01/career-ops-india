import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choose } from '../tools/export-careers.mjs';

test('export picks the best source per company and honours the review', () => {
  const pass1 = [{ company: 'A', status: 'accepted', careers_url: 'https://a.com/careers' }, { company: 'B', status: 'queued', careers_url: '' }, { company: 'C', status: 'accepted', careers_url: 'https://c.com/careers' }];
  const pass2 = [
    { company: 'B', final_status: 'right-portal-no-india', careers_url: 'https://jobs.lever.co/b' },
    { company: 'D', final_status: 'needs-identity-check', careers_url: 'https://lookalike.com' },
    { company: 'E', final_status: 'jobs-found', jobs_india: '5', careers_url: 'https://jobs.lever.co/e' },
  ];
  const pass3 = [{ company: 'B', decision: 'switch', new_url: 'https://jobs.lever.co/b-india' }];
  const review = { C: { decision: 'bad' }, D: { decision: 'ok', careers_url: 'https://d.com/jobs' } };
  const rows = Object.fromEntries(choose({ pass1, pass2, pass3, review }).map((r) => [r.name, r]));
  assert.equal(rows.A.source, 'pass1');
  assert.equal(rows.B.url, 'https://jobs.lever.co/b-india', 'pass 3 switch wins');
  assert.equal(rows.C, undefined, 'crossed in the dashboard: dropped');
  assert.equal(rows.D.url, 'https://d.com/jobs', 'a tick uses your edited URL');
  assert.equal(rows.E.mode, 'scan');
});

test('a page whose jobs were not read is exported as watch, never scan', () => {
  const rows = choose({ pass2: [{ company: 'U', final_status: 'listings-unread', careers_url: 'https://u.com/careers' }, { company: 'K', final_status: 'india-unknown', careers_url: 'https://k.com/c' }] });
  assert.deepEqual(rows.map((r) => r.mode), ['watch', 'watch']);
});

test('right-portal-no-india with no pass 3 switch is exported as watch', () => {
  const rows = choose({ pass2: [{ company: 'B', final_status: 'right-portal-no-india', careers_url: 'https://jobs.lever.co/b' }] });
  assert.equal(rows[0].mode, 'watch');
});

import { outcomeOf, indiaPass } from '../lib/careers-pass2.mjs';
test('outcomes: only India jobs fetched is a pass', () => {
  assert.equal(outcomeOf('jobs-found', 3), 'pass');
  assert.equal(outcomeOf('listings-on-page', '2'), 'pass');
  assert.equal(outcomeOf('right-portal-no-india', 0), 'no-india-jobs');
  assert.equal(outcomeOf('jobs-found', ''), 'india-unknown');
  assert.equal(outcomeOf('india-unknown', ''), 'india-unknown');
  assert.equal(outcomeOf('listings-unread', ''), 'no-jobs-read');
  assert.equal(outcomeOf('bot-blocked', ''), 'blocked');
  assert.equal(outcomeOf('needs-identity-check', ''), 'check-identity');
  assert.equal(outcomeOf('no-candidate', ''), 'not-found');
  assert.ok(indiaPass({ verdict: 'jobs-found', india: 1 }) && !indiaPass({ verdict: 'jobs-found', india: 0 }) && !indiaPass({ verdict: 'listings-unread', india: 5 }));
});

import { mergePass2 } from '../tools/careers-review.mjs';
test('dashboard: a pass 2 result replaces the pass 1 flag and keeps the careers page', () => {
  const rows = mergePass2(
    [{ company: 'A', flag: 'bot-blocked', careers_url: '' }, { company: 'B', flag: 'ok', careers_url: 'https://b.com' }],
    [{ company: 'A', final_status: 'right-portal-no-india', careers_url: 'https://jobs.lever.co/a', jobs_total: '8', jobs_india: '0', sample_titles: 'Engineer', notes: '' }],
  );
  assert.equal(rows[0].flag, 'no-india-jobs');
  assert.equal(rows[0].careers_url, 'https://jobs.lever.co/a');
  assert.equal(rows[0].p1_flag, 'bot-blocked');
  assert.equal(rows[1].flag, 'ok', 'no pass 2 row: unchanged');
});
