import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardsToSkip, hostsToThrottle } from '../lib/board-backoff.mjs';
import { classifyFetchError } from '../verify-portals.mjs';
import { parallelFetch } from '../scan.mjs';

const at = (iso) => new Date(iso);
const rec = (timestamp, company, status) => ({ timestamp, company, status });

test('one 404 does not hold a board', () => {
  const records = [rec('2026-11-01T00:00:00Z', 'Gone Co', 'slug_gone')];
  assert.equal(boardsToSkip(records, { now: at('2026-11-09T00:00:00Z') }).size, 0);
});

test('two 404s in a row at least 24 hours apart hold the board for 30 days, then it is retried', () => {
  const records = [rec('2026-10-20T00:00:00Z', 'Gone Co', 'slug_gone'), rec('2026-10-22T00:00:00Z', 'Gone Co', 'slug_gone')];
  assert.equal(boardsToSkip(records, { now: at('2026-11-09T00:00:00Z') }).get('Gone Co').reason, 'dead');
  assert.equal(boardsToSkip(records, { now: at('2026-11-22T00:00:00Z') }).has('Gone Co'), false);
});

test('two 404s on the same day count as one strike', () => {
  const records = [rec('2026-11-08T08:00:00Z', 'Gone Co', 'slug_gone'), rec('2026-11-08T20:00:00Z', 'Gone Co', 'slug_gone')];
  assert.equal(boardsToSkip(records, { now: at('2026-11-09T00:00:00Z') }).size, 0);
});

test('a healthy run between two 404s breaks the streak', () => {
  const records = [
    rec('2026-10-20T00:00:00Z', 'Gone Co', 'slug_gone'),
    rec('2026-10-25T00:00:00Z', 'Gone Co', 'reachable'),
    rec('2026-11-01T00:00:00Z', 'Gone Co', 'slug_gone'),
  ];
  assert.equal(boardsToSkip(records, { now: at('2026-11-09T00:00:00Z') }).size, 0);
});

test('records are sorted by timestamp, so input order does not matter', () => {
  const inOrder = [rec('2026-10-20T00:00:00Z', 'A', 'slug_gone'), rec('2026-10-22T00:00:00Z', 'A', 'slug_gone')];
  const shuffled = [inOrder[1], inOrder[0]];
  const now = at('2026-11-09T00:00:00Z');
  assert.equal(boardsToSkip(shuffled, { now }).has('A'), true);
  // a healthy record that is LAST in time but first in the array still clears the hold
  const healthyLast = [rec('2026-11-05T00:00:00Z', 'A', 'reachable'), ...inOrder];
  assert.equal(boardsToSkip(healthyLast, { now }).has('A'), false);
});

test('timeouts, network errors and 429s never hold a board', () => {
  const records = [
    rec('2026-11-08T00:00:00Z', 'Flaky', 'network'), rec('2026-11-09T00:00:00Z', 'Flaky', 'network'),
    rec('2026-11-08T00:00:00Z', 'Busy', 'rate_limited'), rec('2026-11-09T00:00:00Z', 'Busy', 'rate_limited'),
  ];
  assert.equal(boardsToSkip(records, { now: at('2026-11-09T01:00:00Z') }).size, 0);
});

test('a host that answered 429 recently is throttled; an old 429 or another host is not', () => {
  const hostOf = (company) => ({ A: 'boards-api.greenhouse.io', B: 'api.lever.co' })[company];
  const records = [rec('2026-11-09T00:00:00Z', 'A', 'rate_limited'), rec('2026-10-01T00:00:00Z', 'B', 'rate_limited')];
  const hosts = hostsToThrottle(records, hostOf, { now: at('2026-11-09T10:00:00Z') });
  assert.deepEqual([...hosts], ['boards-api.greenhouse.io']);
});

test('429 is classified as rate_limited, 404 as slug_gone, a timeout as network', () => {
  assert.equal(classifyFetchError({ status: 429 }), 'rate_limited');
  assert.equal(classifyFetchError(new Error('HTTP 429 Too Many Requests')), 'rate_limited');
  assert.equal(classifyFetchError({ status: 404 }), 'slug_gone');
  assert.equal(classifyFetchError({ name: 'AbortError' }), 'network');
});

test('parallelFetch runs a throttled host one at a time and pauses between its requests', async () => {
  let running = 0;
  let maxRunning = 0;
  const stamps = [];
  const task = () => async () => {
    running++; maxRunning = Math.max(maxRunning, running);
    stamps.push(Date.now());
    await new Promise((r) => setTimeout(r, 5));
    running--;
  };
  const tasks = [task(), task(), task()];
  await parallelFetch(tasks, 3, () => {}, {
    hostOf: () => 'slow.example', hostLimit: 3,
    hostLimitOf: () => 1, hostDelayOf: () => 40,
  });
  assert.equal(maxRunning, 1);
  assert.ok(stamps[1] - stamps[0] >= 35 && stamps[2] - stamps[1] >= 35, `gaps ${stamps[1] - stamps[0]}, ${stamps[2] - stamps[1]}`);
});

test('parallelFetch without overrides keeps the old per-host limit', async () => {
  let running = 0;
  let maxRunning = 0;
  const task = () => async () => { running++; maxRunning = Math.max(maxRunning, running); await new Promise((r) => setTimeout(r, 10)); running--; };
  await parallelFetch([task(), task(), task()], 3, () => {}, { hostOf: () => 'h', hostLimit: 2 });
  assert.equal(maxRunning, 2);
});
