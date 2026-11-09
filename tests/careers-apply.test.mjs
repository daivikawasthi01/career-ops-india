import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planChanges, addEntries, replaceBoards, addWeekly } from '../lib/careers-apply.mjs';
import { loadYaml } from '../lib/yaml-document.mjs';

const YAML = `# keep
tracked_companies:
  - name: Alpha
    careers_url: https://jobs.lever.co/alpha
    enabled: true

  - name: Beta
    careers_url: https://boards.greenhouse.io/beta
    enabled: true
job_boards: []
`;
const entries = loadYaml(YAML).tracked_companies;
const rows = [
  { company: 'Alpha', careers_url: 'https://jobs.lever.co/alpha' },
  { company: 'Beta', careers_url: 'https://jobs.ashbyhq.com/beta' },
  { company: 'Gamma', careers_url: 'https://jobs.lever.co/gamma' },
  { company: 'Delta', careers_url: 'https://delta.com/careers' },
  { company: 'Eps', careers_url: 'https://eps.com/careers' },
];

test('only ticked rows are planned, by kind', () => {
  const review = { Alpha: { decision: 'ok' }, Beta: { decision: 'ok' }, Gamma: { decision: 'ok' }, Delta: { decision: 'ok' }, Eps: { decision: 'bad' }, Zed: {} };
  const kinds = Object.fromEntries(planChanges({ review, rows, entries, weeklyText: '' }).map((p) => [p.company, p.kind]));
  assert.deepEqual(kinds, { Alpha: 'same', Beta: 'conflict', Gamma: 'add-new', Delta: 'weekly' });
});

test('an edited URL in the review wins over the discovered one; a tick with no URL is skipped', () => {
  const p = planChanges({ review: { Delta: { decision: 'ok', careers_url: 'https://delta.com/jobs' }, Eps: { decision: 'ok', careers_url: '' } }, rows: [{ company: 'Delta', careers_url: 'https://x.com' }, { company: 'Eps', careers_url: '' }], entries, weeklyText: '' });
  assert.equal(p.find((x) => x.company === 'Delta').url, 'https://delta.com/jobs');
  assert.equal(p.find((x) => x.company === 'Eps').kind, 'skip');
});

test('addEntries inserts inside tracked_companies and keeps the rest; replaceBoards edits only the named entry', () => {
  const r = addEntries(YAML, [{ company: 'Gamma', url: 'https://jobs.lever.co/gamma' }]);
  const y = loadYaml(r.text);
  assert.deepEqual(y.tracked_companies.map((e) => e.name), ['Alpha', 'Beta', 'Gamma']);
  assert.deepEqual(y.job_boards, []);
  assert.ok(r.text.startsWith('# keep\n'));
  const q = replaceBoards(YAML, [{ company: 'Beta', url: 'https://jobs.ashbyhq.com/beta' }]);
  const e = loadYaml(q.text).tracked_companies;
  assert.equal(e[1].careers_url, 'https://jobs.ashbyhq.com/beta');
  assert.equal(e[0].careers_url, 'https://jobs.lever.co/alpha');
});

test('weekly links are appended once', () => {
  const once = addWeekly('# c\n', [{ company: 'Delta', url: 'https://delta.com/careers' }]);
  assert.equal(once, '# c\nDelta | https://delta.com/careers\n');
  const p = planChanges({ review: { Delta: { decision: 'ok' } }, rows, entries, weeklyText: once });
  assert.equal(p[0].kind, 'same');
});
