import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardsToSkip } from '../lib/board-backoff.mjs';
import { classifyFetchError } from '../verify-portals.mjs';

const at = (iso) => new Date(iso);
const rec = (timestamp, company, status) => ({ timestamp, company, status });

test('a board that returned 404 is held for 30 days, then retried', () => {
  const records = [rec('2026-10-20T00:00:00Z', 'Gone Co', 'slug_gone')];
  assert.equal(boardsToSkip(records, { now: at('2026-11-09T00:00:00Z') }).get('Gone Co').reason, 'dead');
  assert.equal(boardsToSkip(records, { now: at('2026-11-20T00:00:00Z') }).has('Gone Co'), false);
});

test('timeouts and network errors are never held', () => {
  const records = [rec('2026-11-08T00:00:00Z', 'Flaky', 'network'), rec('2026-11-09T00:00:00Z', 'Flaky', 'network')];
  assert.equal(boardsToSkip(records, { now: at('2026-11-09T01:00:00Z') }).size, 0);
});

test('a 429 backs off 24h, then 48h, then 96h for repeats in a row', () => {
  const one = [rec('2026-11-09T00:00:00Z', 'Busy', 'rate_limited')];
  assert.ok(boardsToSkip(one, { now: at('2026-11-09T20:00:00Z') }).has('Busy'));
  assert.ok(!boardsToSkip(one, { now: at('2026-11-10T01:00:00Z') }).has('Busy'));

  const two = [rec('2026-11-07T00:00:00Z', 'Busy', 'rate_limited'), rec('2026-11-09T00:00:00Z', 'Busy', 'rate_limited')];
  assert.ok(boardsToSkip(two, { now: at('2026-11-10T20:00:00Z') }).has('Busy'));
  assert.ok(!boardsToSkip(two, { now: at('2026-11-11T01:00:00Z') }).has('Busy'));
});

test('the 429 backoff is capped', () => {
  const many = Array.from({ length: 10 }, (_, i) => rec(`2026-10-${10 + i}T00:00:00Z`, 'Busy', 'rate_limited'));
  assert.ok(!boardsToSkip(many, { now: at('2026-11-10T00:00:00Z') }).has('Busy')); // last at Oct 19, cap 7 days
});

test('a later healthy run clears an earlier failure', () => {
  const records = [rec('2026-11-01T00:00:00Z', 'Back', 'slug_gone'), rec('2026-11-08T00:00:00Z', 'Back', 'reachable')];
  assert.equal(boardsToSkip(records, { now: at('2026-11-09T00:00:00Z') }).size, 0);
});

test('429 is classified as rate_limited, 404 as slug_gone, a timeout as network', () => {
  assert.equal(classifyFetchError({ status: 429 }), 'rate_limited');
  assert.equal(classifyFetchError(new Error('HTTP 429 Too Many Requests')), 'rate_limited');
  assert.equal(classifyFetchError({ status: 404 }), 'slug_gone');
  assert.equal(classifyFetchError({ name: 'AbortError' }), 'network');
});
