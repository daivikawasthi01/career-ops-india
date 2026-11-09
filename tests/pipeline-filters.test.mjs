import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minExperienceYears, seniorityVerdict } from '../lib/seniority.mjs';
import { batchYears, yearOk } from '../lib/batch-year.mjs';
import { minYears } from '../scan-jobspy.mjs';
import { pruneRejected, createRejectedLog } from '../lib/rejected-log.mjs';
import { addFlag } from '../lib/offer-flags.mjs';
import { applyPipelineConfig } from '../lib/pipeline-config.mjs';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const guard = { enabled: true, flag_min_years: 2, drop_min_years: 3 };

test('seniority: reads the stated minimum', () => {
  assert.equal(minExperienceYears('3+ years of experience in Java'), 3);
  assert.equal(minExperienceYears('Minimum 2 years in backend'), 2);
  assert.equal(minExperienceYears('5 years of relevant experience'), 5);
  assert.equal(minExperienceYears('We were founded 12 years ago'), null);
  assert.equal(minExperienceYears('at least 4 years old company'), null);
});
test('seniority: fresher wording wins', () => {
  assert.equal(minExperienceYears('Freshers welcome. 3+ years preferred'), 0);
  assert.equal(minExperienceYears('0-2 years of experience'), 0);
});
test('seniority verdict: keep, flag, drop, off', () => {
  assert.equal(seniorityVerdict('1 year of experience', guard).action, 'keep');
  assert.equal(seniorityVerdict('2+ years of experience', guard).action, 'flag');
  assert.equal(seniorityVerdict('4+ years of experience', guard).action, 'drop');
  assert.equal(seniorityVerdict('4+ years of experience', { ...guard, drop_min_years: null }).action, 'flag');
  assert.equal(seniorityVerdict('4+ years of experience', { enabled: false }).action, 'keep');
  assert.equal(seniorityVerdict('no numbers here', guard).action, 'keep');
});

test('batch year: every year in the span counts, list is configurable', () => {
  assert.deepEqual(batchYears('2026 and 2027 Batch').sort(), ['2026', '2027']);
  assert.equal(yearOk('2026 and 2027 Batch', ['2027']), true);
  assert.equal(yearOk('2025 batch only', ['2027']), false);
  assert.equal(yearOk('2026 batch', ['2026', '2027']), true);
  assert.equal(yearOk('Software Engineer, founded 1999', ['2027']), true);
});

test('naukri: the MINIMUM of a range decides', () => {
  assert.equal(minYears('0-1 Yrs'), 0);
  assert.equal(minYears('0-2 Yrs'), 0);
  assert.equal(minYears('0 Yrs'), 0);
  assert.equal(minYears('2-4 Yrs'), 2);
  assert.equal(minYears(''), null);
});

test('rejected log: prunes rows older than the retention', () => {
  const now = new Date('2026-11-09T00:00:00Z');
  const lines = ['2026-09-01T00:00:00.000Z\ta', '2026-11-01T00:00:00.000Z\tb'];
  assert.deepEqual(pruneRejected(lines, { now, days: 30 }), [lines[1]]);
});
test('rejected log: writes a row per rejection and flushes once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rej-'));
  const path = join(dir, 'rejected.tsv');
  const log = createRejectedLog(path, { days: 30 });
  log.add({ source: 'x', company: 'Co', title: 'Sales\tIntern', url: 'https://a' }, 'title');
  assert.equal(log.flush(), 1);
  const text = readFileSync(path, 'utf-8').trim().split('\n');
  assert.equal(text.length, 2);
  assert.ok(text[1].endsWith('\ttitle') && text[1].includes('Sales Intern'));
});

test('flags: added once to the offer and its location', () => {
  const o = { location: 'Pune' };
  addFlag(addFlag(o, 'unpaid'), 'unpaid');
  assert.deepEqual(o.flags, ['unpaid']);
  assert.equal(o.location, 'Pune [unpaid]');
});

test('pipeline.yml replaces portals.yml title_filter and title_filter_full', () => {
  const cfg = applyPipelineConfig({ title_filter: { positive: ['old'] }, title_filter_full: { positive: ['older'] } }, { title_filter: { positive: ['new'], negative: [] } });
  assert.deepEqual(cfg.title_filter.positive, ['new']);
  assert.equal(cfg.title_filter_full, undefined);
});
