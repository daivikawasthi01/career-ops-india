import test from 'node:test';
import assert from 'node:assert/strict';
import { slowLane } from '../scan-jobspy.mjs';
import { jobspySites } from '../lib/jobspy-sites.mjs';

test('slowLane applies config and falls back to safe defaults', () => {
  const d = slowLane(undefined, ['linkedin', 'glassdoor']);
  assert.deepEqual(d.sites, ['linkedin', 'glassdoor']);
  assert.deepEqual(d.budget, { linkedin: 3, glassdoor: 3 });
  assert.deepEqual(d.jitter.linkedin, [20, 45]);
  assert.equal(d.days, 1);
  const c = slowLane({ per_run: 2, days: 2, jitter_seconds: [30, 60] }, ['linkedin']);
  assert.deepEqual(c, { sites: ['linkedin'], days: 2, budget: { linkedin: 2 }, jitter: { linkedin: [30, 60] } });
  assert.equal(slowLane({ per_run: -1, days: 0 }, ['linkedin']).budget.linkedin, 3);
  assert.deepEqual(slowLane({}, []).sites, []);
});

test('jobspySites splits the one site table into first-pass and slow sites with budgets and pauses', () => {
  const t = jobspySites({ a: { first_pass: true, budget: 5, jitter_seconds: [1, 2] }, b: { slow: true, budget: 2 }, c: {} });
  assert.deepEqual([t.all, t.firstPass, t.slow], [['a', 'b', 'c'], ['a'], ['b']]);
  assert.deepEqual(t.budget, { a: 5, b: 2 });
  assert.deepEqual(t.jitter, { a: [1, 2] });
  assert.deepEqual(jobspySites(undefined).all, []); // no table: nothing configured, nothing crashes
});
