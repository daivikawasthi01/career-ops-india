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

test('dashboard rows carry the other pages pass 2 found, so one of several same-name companies can be picked', () => {
  const alts = JSON.stringify([{ u: 'https://bluestone.co.in/careers/', v: 'listings-unread', jobs: '', india: '' }]);
  const [r] = mergePass2([{ company: 'Bluestone', flag: 'review', careers_url: '' }], [{ company: 'Bluestone', final_status: 'listings-unread', careers_url: 'https://www.bluestone.com/career', alternatives: alts }]);
  assert.equal(r.alternatives.length, 1);
  assert.equal(r.alternatives[0].u, 'https://bluestone.co.in/careers/');
  assert.deepEqual(mergePass2([{ company: 'X', flag: 'ok' }], [{ company: 'X', final_status: 'jobs-found', jobs_india: '2', alternatives: 'not json' }])[0].alternatives, []);
});

import { makeServer, phaseView } from '../tools/careers-review.mjs';
test('the dashboard page serves a script that parses, and the run endpoints answer', async () => {
  const server = makeServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(base + '/')).text();
    const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
    assert.doesNotThrow(() => new Function(script), 'page script has a syntax error');
    assert.ok(html.includes('id="runs"'));
    const runs = await (await fetch(base + '/api/runs')).json();
    assert.equal(runs.length, 3);
    assert.deepEqual(await (await fetch(base + '/api/log?phase=9')).json(), []);
  } finally { server.close(); }
});

test('a run that stopped updating shows as stopped, a fresh one as live', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  assert.equal(phaseView({ state: 'running', updated_at: '2026-11-09T11:59:30Z' }, now).live, true);
  const old = phaseView({ state: 'running', updated_at: '2026-11-09T11:50:00Z' }, now);
  assert.equal(old.state, 'stopped'); assert.equal(old.live, false);
  assert.equal(phaseView({ state: 'finished', updated_at: '2026-11-09T10:00:00Z' }, now).state, 'finished');
});
