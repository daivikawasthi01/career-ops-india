import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreJobs, decideChange } from '../board-india-check.mjs';
import { setEnabledInText } from '../lib/portals-edit.mjs';

const inIndia = (loc) => /india|bengaluru|pune/i.test(loc || '');
const entryTitle = (t) => /engineer|sde|trainee/i.test(t) && !/senior/i.test(t);

test('scoreJobs counts india, entry-level, and both separately', () => {
  const jobs = [
    { title: 'Software Engineer', location: 'Bengaluru, India' },   // both
    { title: 'Software Engineer', location: 'Berlin' },             // entry only
    { title: 'Account Executive', location: 'Pune' },               // india only
    { title: 'Senior Engineer', location: 'Pune' },                 // india only (senior blocked)
  ];
  assert.deepEqual(scoreJobs(jobs, entryTitle, inIndia), { total: 4, india: 3, entry: 2, both: 1 });
  assert.deepEqual(scoreJobs(undefined, entryTitle, inIndia), { total: 0, india: 0, entry: 0, both: 0 });
});

test('decideChange: disable a zero-scoring enabled board, enable a disabled jobradar board that scores, never act on errors', () => {
  const zero = { status: 'ok', both: 0 };
  const hit = { status: 'ok', both: 3 };
  assert.equal(decideChange({ name: 'A' }, zero), 'disable');
  assert.equal(decideChange({ name: 'A', enabled: true }, zero), 'disable');
  assert.equal(decideChange({ name: 'A', enabled: false, source: 'jobradar' }, zero), null);
  assert.equal(decideChange({ name: 'B', enabled: false, source: 'jobradar' }, hit), 'enable');
  assert.equal(decideChange({ name: 'B', enabled: false }, hit), null, 'a board you disabled yourself stays off');
  assert.equal(decideChange({ name: 'C' }, hit), null);
  assert.equal(decideChange({ name: 'D' }, { status: 'error', both: 0 }), null);
  assert.equal(decideChange({ name: 'D' }, { status: 'no_provider', both: 0 }), null);
});

const YAML = `# keep me
tracked_companies:
  - name: Alpha
    careers_url: https://jobs.lever.co/alpha
    enabled: true

  - name: "Beta, Inc."
    careers_url: https://jobs.lever.co/beta
    enabled: false
    source: jobradar

  - name: Gamma
    careers_url: https://jobs.lever.co/gamma
job_boards: []
`;

test('setEnabledInText flips only the named entry and keeps everything else', () => {
  const r = setEnabledInText(YAML, 'Alpha', false, 'no India postings');
  assert.ok(r.changed && r.found);
  assert.match(r.text, /- name: Alpha\n    careers_url: .*alpha\n    enabled: false\n    # no India postings\n/);
  assert.ok(r.text.startsWith('# keep me\n'));
  assert.ok(r.text.includes('  - name: "Beta, Inc."\n    careers_url: https://jobs.lever.co/beta\n    enabled: false'));
});

test('setEnabledInText handles quoted names, a missing enabled line, and a name that is absent', () => {
  assert.match(setEnabledInText(YAML, 'Beta, Inc.', true).text, /name: "Beta, Inc."\n    careers_url: .*\n    enabled: true\n    source: jobradar/);
  assert.match(setEnabledInText(YAML, 'Gamma', false).text, /- name: Gamma\n    enabled: false\n    careers_url/);
  const r = setEnabledInText(YAML, 'Nope', false);
  assert.equal(r.found, false);
  assert.equal(r.text, YAML);
});

test('setEnabledInText is a no-op when the value already matches', () => {
  const r = setEnabledInText(YAML, 'Alpha', true);
  assert.equal(r.changed, false);
  assert.equal(r.text, YAML);
});
