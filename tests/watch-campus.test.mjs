import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleText, hashText, findSignals, diffState, CAMPUS_URL_RE } from '../tools/watch-campus.mjs';

const page = (body) => `<html><head><script>var x=1</script></head><body><nav>menu</nav>${body}<footer>© 2026</footer></body></html>`;
const long = 'Our graduate programme gives students real projects. '.repeat(8);

test('visibleText ignores chrome, timestamps and counters so the hash is stable', () => {
  const a = visibleText(page(`<p>${long}</p><span>Updated 2026-11-10T09:00:00Z</span><i>120 views</i>`));
  const b = visibleText(page(`<p>${long}</p><span>Updated 2026-11-11T10:30:00Z</span><i>340 views</i>`));
  assert.equal(hashText(a), hashText(b));
  assert.doesNotMatch(a, /menu|var x/);
});
test('findSignals spots season signals', () => {
  assert.deepEqual(findSignals('Applications are now open for the 2027 batch'), ['applications-open', 'batch-2027']);
  assert.deepEqual(findSignals('nothing here'), []);
  assert.ok(findSignals('Registrations closed').includes('closed'));
});
test('diffState: baseline, unchanged, changed, newly gained signal', () => {
  const t1 = visibleText(page(`<p>${long}</p>`));
  const a = diffState(undefined, { ok: true, text: t1 }, '2026-11-10');
  assert.equal(a.event.kind, 'new');
  assert.equal(diffState(a.next, { ok: true, text: t1 }, '2026-11-11').event, null);
  const big = Array.from({ length: 200 }, (_, k) => `word${String.fromCharCode(97 + (k % 26))}${String.fromCharCode(97 + ((k * 7) % 26))}${String.fromCharCode(97 + ((k * 3) % 26))}x${'abcdefghij'[k % 10]}`).join(' ') + ' ' + long;
  const base = diffState(undefined, { ok: true, text: big }, 'd').next;
  assert.equal(diffState(base, { ok: true, text: big + ' rotating banner today' }, 'e').event, null, 'a small rotating bit is not a change');
  const t2 = 'Completely different programme about robotics research fellowships and laboratory placements across campuses. '.repeat(6);
  assert.equal(diffState(a.next, { ok: true, text: t2 }, '2026-11-11').event.kind, 'changed');
  const t3 = t1 + ' Applications are now open for the 2027 batch';
  const s = diffState(a.next, { ok: true, text: t3 }, '2026-11-11').event;
  assert.equal(s.kind, 'signal'); assert.ok(s.signals.includes('applications-open'));
});
test('diffState: a page is only called dead after three failures in a row; success resets', () => {
  let st; const fail = { ok: false, error: 'HTTP 404' };
  const events = [];
  for (let i = 0; i < 3; i++) { const r = diffState(st, fail, 'd'); st = r.next; events.push(r.event); }
  assert.deepEqual(events.map((e) => e?.kind || null), [null, null, 'dead']);
  const back = diffState(st, { ok: true, text: long }, 'd');
  assert.equal(back.next.fails, 0);
});
test('CAMPUS_URL_RE keeps early-career pages and drops product pages', () => {
  assert.ok(CAMPUS_URL_RE.test('/early-careers/'));
  assert.ok(!CAMPUS_URL_RE.test('/solutions/payments'));
});

import { readWithBrowser, NOISE_URL_RE } from '../tools/watch-campus.mjs';
test('readWithBrowser reads each url through one browser, reports a launch failure per url, and always closes', async () => {
  const closed = []; const text = 'x'.repeat(300);
  const launch = async () => ({ newPage: async () => ({ goto: async (u) => { if (u.includes('bad')) throw new Error('net::ERR_FAILED\nmore'); }, waitForTimeout: async () => {}, evaluate: async () => text, close: async () => {} }), close: async () => closed.push(1) });
  const got = {}; await readWithBrowser(['https://a.example/', 'https://bad.example/'], (u, r) => { got[u] = r; }, launch);
  assert.equal(got['https://a.example/'].ok, true);
  assert.match(got['https://bad.example/'].error, /ERR_FAILED/);
  assert.equal(closed.length, 1);
  const none = {}; await readWithBrowser(['https://a.example/'], (u, r) => { none[u] = r; }, async () => { throw new Error('no chromium'); });
  assert.match(none['https://a.example/'].error, /browser unavailable/);
});
test('noise filter drops discount, login and press pages', () => {
  for (const p of ['/education/student-discount', '/student/login', '/pressreleases/2026-mou', '/credit-cards/best/college-student']) assert.ok(NOISE_URL_RE.test(p), p);
  assert.ok(!NOISE_URL_RE.test('/careers/early-careers'));
});
