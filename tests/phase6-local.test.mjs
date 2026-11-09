import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import { isLoopback, portFree } from '../lib/local-service.mjs';
import { rateLimitNote, fetchJson } from '../scan-freehire.mjs';
import { nextRotation } from '../scan-jobspy.mjs';

test('only local addresses count as loopback', () => {
  assert.ok(isLoopback('http://localhost:8000'));
  assert.ok(isLoopback('http://127.0.0.1:9000/x'));
  assert.ok(!isLoopback('http://0.0.0.0:8000'));
  assert.ok(!isLoopback('http://192.168.1.5:8000'));
  assert.ok(!isLoopback('not a url'));
});

test('portFree sees a busy port', async () => {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  assert.equal(await portFree(port), false);
  await new Promise((r) => srv.close(r));
  assert.equal(await portFree(port), true);
});

test('rate-limit headers are reported when present', () => {
  const h = new Headers({ 'x-ratelimit-remaining': '41', 'retry-after': '3' });
  assert.equal(rateLimitNote(h), 'retry-after=3 x-ratelimit-remaining=41');
  assert.equal(rateLimitNote(new Headers()), '');
});

test('freehire: one retry after a 429, then success', async () => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => (++calls === 1
    ? new Response('slow', { status: 429, headers: { 'retry-after': '0' } })
    : new Response(JSON.stringify({ data: [] }), { status: 200 }));
  try {
    const body = await fetchJson('https://example.test/x', 0, { retries: 1, backoff_seconds: 0, max_retry_after_seconds: 0 });
    assert.deepEqual(body, { data: [] });
    assert.equal(calls, 2);
  } finally { globalThis.fetch = real; }
});

test('freehire: gives up after the configured retries and says why', async () => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('down', { status: 503 }); };
  try {
    await assert.rejects(fetchJson('https://example.test/x', 0, { retries: 1, backoff_seconds: 0 }), /503 after 1 retry/);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = real; }
});

test('freehire: a network error is retried once, then reported as unreachable', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  try {
    await assert.rejects(fetchJson('https://example.test/x', 0, { retries: 1, backoff_seconds: 0 }), /unreachable/);
  } finally { globalThis.fetch = real; }
});

test('jobspy rotation restarts at the first term the budget skipped', () => {
  const terms = ['a', 'b', 'c', 'd'];
  assert.equal(nextRotation(0, [], terms), 0);
  assert.equal(nextRotation(0, [['linkedin', 'c'], ['linkedin', 'd']], terms), 2);
  assert.equal(nextRotation(2, [['linkedin', 'a']], terms), 0);
});
