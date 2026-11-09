import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreJobs, decideChange, decideRecheck } from '../board-india-check.mjs';
import { setEnabledInText, setFieldInText, autoDisabledNames } from '../lib/portals-edit.mjs';

const inIndia = (loc) => /india|bengaluru|pune/i.test(loc || '');
const entryTitle = (t) => /engineer|sde|trainee/i.test(t) && !/senior/i.test(t);

test('scoreJobs counts india, entry-level, and both separately', () => {
  const jobs = [
    { title: 'Software Engineer', location: 'Bengaluru, India' },   // both
    { title: 'Software Engineer', location: 'Berlin' },             // entry only
    { title: 'Account Executive', location: 'Pune' },               // india only
    { title: 'Senior Engineer', location: 'Pune' },                 // india only (senior blocked)
  ];
  assert.deepEqual(scoreJobs(jobs, entryTitle, inIndia), { total: 4, india: 3, entry: 2, both: 1, india_any: 3, india_entry: 1 });
  assert.deepEqual(scoreJobs(undefined, entryTitle, inIndia), { total: 0, india: 0, entry: 0, both: 0, india_any: 0, india_entry: 0 });
});

const ok = (india_any, india_entry) => ({ status: 'ok', india_any, india_entry });

test('decideChange: disable only when nothing is located in India at any level', () => {
  assert.equal(decideChange({ name: 'A' }, ok(0, 0)), 'disable');
  assert.equal(decideChange({ name: 'A', enabled: true }, ok(0, 0)), 'disable');
  assert.equal(decideChange({ name: 'A', enabled: false }, ok(0, 0)), null, 'already off');
});

test('decideChange: India postings but none entry-level stay enabled and get watched', () => {
  assert.equal(decideChange({ name: 'Swiggy' }, ok(189, 0)), 'watch');
  assert.equal(decideChange({ name: 'Swiggy', watch: true }, ok(189, 0)), null, 'already watched');
  assert.equal(decideChange({ name: 'Wabtec' }, ok(105, 32)), null, 'has entry-level postings: nothing to do');
});

test('decideChange: protected boards are never disabled and are always on and watched', () => {
  const protectedSet = new Set(['tide', 'sagent']);
  assert.equal(decideChange({ name: 'TIDE' }, ok(0, 0), { protectedSet }), 'watch');
  assert.equal(decideChange({ name: 'TIDE', watch: true }, ok(0, 0), { protectedSet }), null);
  assert.equal(decideChange({ name: 'Sagent', enabled: false }, ok(5, 0), { protectedSet }), 'enable-watch');
  assert.equal(decideChange({ name: 'Other' }, ok(0, 0), { protectedSet }), 'disable');
});

test('decideChange: a jobradar board comes back on only with an entry-level posting; errors are never zero', () => {
  assert.equal(decideChange({ name: 'B', enabled: false, source: 'jobradar' }, ok(4, 3)), 'enable');
  assert.equal(decideChange({ name: 'B', enabled: false }, ok(4, 3)), null, 'a board you disabled yourself stays off');
  assert.equal(decideChange({ name: 'D' }, { status: 'error', india_any: 0, india_entry: 0 }), null);
  assert.equal(decideChange({ name: 'D' }, { status: 'no_provider', india_any: 0, india_entry: 0 }), null);
});

test('decideRecheck re-enables an auto-disabled board that now has any India posting', () => {
  assert.equal(decideRecheck({ name: 'A', enabled: false }, ok(2, 0)), 'reenable');
  assert.equal(decideRecheck({ name: 'A', enabled: false }, ok(0, 0)), null);
  assert.equal(decideRecheck({ name: 'A', enabled: true }, ok(2, 0)), null);
  assert.equal(decideRecheck({ name: 'A', enabled: false }, { status: 'error' }), null);
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

test('setFieldInText adds watch after the enabled line, keeps its note attached, and is idempotent', () => {
  const off = setEnabledInText(YAML, 'Alpha', false, 'auto-disabled 2026-11-09 by board-india-check (india_any=0)').text;
  const w = setFieldInText(off, 'Alpha', 'watch', 'true');
  assert.ok(w.changed);
  assert.match(w.text, /- name: Alpha\n    careers_url: .*\n    enabled: false\n    # auto-disabled .*\n    watch: true\n/);
  assert.equal(setFieldInText(w.text, 'Alpha', 'watch', 'true').changed, false);
  assert.equal(setFieldInText(YAML, 'Nope', 'watch', 'true').found, false);
  assert.match(setFieldInText(YAML, 'Gamma', 'watch', 'true').text, /- name: Gamma\n    watch: true\n    careers_url/);
});

test('autoDisabledNames lists only entries carrying the auto-disabled note', () => {
  let t = setEnabledInText(YAML, 'Alpha', false, 'auto-disabled 2026-11-09 by board-india-check (india_any=0)').text;
  t = setEnabledInText(t, 'Gamma', false, 'disabled by hand').text;
  assert.deepEqual(autoDisabledNames(t), ['Alpha']);
});
