import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choose } from '../tools/export-careers.mjs';

test('export picks the best source per company and honours the review', () => {
  const pass1 = [{ company: 'A', status: 'accepted', careers_url: 'https://a.com/careers' }, { company: 'B', status: 'queued', careers_url: '' }, { company: 'C', status: 'accepted', careers_url: 'https://c.com/careers' }];
  const pass2 = [
    { company: 'B', final_status: 'right-portal-no-india', careers_url: 'https://jobs.lever.co/b' },
    { company: 'D', final_status: 'needs-identity-check', careers_url: 'https://lookalike.com' },
    { company: 'E', final_status: 'jobs-found', careers_url: 'https://jobs.lever.co/e' },
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
