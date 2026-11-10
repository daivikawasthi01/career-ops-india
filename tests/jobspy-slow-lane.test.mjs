import test from 'node:test';
import assert from 'node:assert/strict';
import { slowLane } from '../scan-jobspy.mjs';

test('slowLane applies config and falls back to safe defaults', () => {
  const d = slowLane(undefined);
  assert.deepEqual(d.sites, ['linkedin', 'glassdoor']);
  assert.deepEqual(d.budget, { linkedin: 3, glassdoor: 3 });
  assert.deepEqual(d.jitter.linkedin, [20, 45]);
  assert.equal(d.days, 1);
  const c = slowLane({ sites: ['linkedin'], per_run: 2, days: 2, jitter_seconds: [30, 60] });
  assert.deepEqual(c, { sites: ['linkedin'], days: 2, budget: { linkedin: 2 }, jitter: { linkedin: [30, 60] } });
  assert.equal(slowLane({ per_run: -1, days: 0 }).budget.linkedin, 3);
});
