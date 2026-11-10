import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugCandidates, isMiss, boardsToYaml, readNames } from '../tools/probe-india-ats.mjs';

test('slugCandidates: domain label and full name are high confidence, first word is low', () => {
  const m = Object.fromEntries(slugCandidates('Jupiter Money Pvt Ltd', '').map((x) => [x.slug, x.confidence]));
  assert.equal(m['jupitermoney'], 'high');
  assert.equal(m['jupiter'], 'low');
  const d = Object.fromEntries(slugCandidates('Jupiter Money', 'https://www.jupiter.money/').map((x) => [x.slug, x.confidence]));
  assert.equal(d['jupiter'], 'high');
});
test('slugCandidates: legal suffixes are stripped, junk labels dropped', () => {
  const m = Object.fromEntries(slugCandidates('Acme Technologies Private Limited', 'acme.co.in').map((x) => [x.slug, x.confidence]));
  assert.equal(m['acme'], 'high');
  assert.deepEqual(slugCandidates('A', ''), []);
});
test('isMiss separates a definite missing tenant from a transient failure', () => {
  assert.ok(isMiss('keka', Object.assign(new Error('keka: x ... no such tenant'), { status: 404 })));
  assert.ok(isMiss('darwinbox', Object.assign(new Error('HTTP 500'), { status: 500 })));
  assert.ok(isMiss('zoho', new Error('zoho-recruit: no id="jobs" input on /jobs/Careers')));
  assert.ok(isMiss('eightfold', Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })));
  assert.ok(!isMiss('keka', Object.assign(new Error('HTTP 429'), { status: 429 })));
  assert.ok(!isMiss('darwinbox', new Error('timeout')));
  assert.ok(!isMiss('eightfold', new Error('fetch failed')));
});
test('boardsToYaml skips empty boards and low confidence by default', () => {
  const rows = [{ company: 'A', vendor: 'keka', url: 'https://a.keka.com/careers', jobs: '3', india: '3', confidence: 'high', sample: 's' },
    { company: 'B', vendor: 'keka', url: 'https://b.keka.com/careers', jobs: '0', india: '0', confidence: 'high', sample: '' },
    { company: 'C', vendor: 'keka', url: 'https://c.keka.com/careers', jobs: '4', india: '1', confidence: 'low', sample: '' }];
  const y = boardsToYaml(rows);
  assert.match(y, /a\.keka\.com/); assert.doesNotMatch(y, /b\.keka\.com|c\.keka\.com/);
  assert.match(boardsToYaml(rows, 'low'), /c\.keka\.com/);
});
test('readNames dedups across sources and strips CSV junk', () => {
  const names = readNames({ companiesFile: null, discoveryFile: null, extra: ['Foo Bar', 'foo-bar', 'Chapter Homes,series_a,,India,funding:x', '# c'] });
  assert.deepEqual(names.map((n) => n.name).sort(), ['Chapter Homes', 'Foo Bar']);
});
import { boardsYaml, SCANNABLE } from '../tools/classify-directory-boards.mjs';
test('classify-directory-boards emits only verified, non-empty boards', () => {
  const y = boardsYaml([{ company: 'A', ats: 'keka', url: 'https://a.keka.com/careers', jobs: '4', india: '3', verdict: 'ok' }, { company: 'B', ats: 'keka', url: 'https://b.keka.com/careers', jobs: '0', verdict: 'empty' }, { company: 'C', ats: 'lever', url: 'https://jobs.lever.co/c', jobs: '2', india: '0', verdict: 'error' }]);
  assert.match(y, /a\.keka\.com/); assert.doesNotMatch(y, /b\.keka|lever\.co\/c/);
  assert.ok(SCANNABLE.has('workday') && !SCANNABLE.has('custom'));
});
