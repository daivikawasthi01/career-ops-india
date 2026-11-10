import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatEta, barLine, createProgress } from '../lib/progress.mjs';

test('eta reads as seconds, minutes or hours', () => {
  assert.equal(formatEta(42), '42s');
  assert.equal(formatEta(125), '2m05s');
  assert.equal(formatEta(7500), '2h05m');
  assert.equal(formatEta(NaN), '--');
});

test('the live line shows bar, count, percent, top outcomes, rate and eta', () => {
  const l = barLine({ label: 'pass 2', done: 25, total: 100, counts: { pass: 10, 'not-found': 5, blocked: 1 }, elapsedSec: 100, width: 10 });
  assert.match(l, /^pass 2 ███░░░░░░░ 25\/100 25\.0%/);
  assert.match(l, /pass 10 not-found 5 blocked 1/);
  assert.match(l, /4\.0s\/item \| ETA 5m00s$/);
  assert.match(barLine({ done: 0, total: 5 }), /--\/?|ETA --/);
});

test('without a terminal it prints plain lines, keeps console working and restores it', () => {
  const lines = []; const stream = { isTTY: false, write: (s) => lines.push(s) };
  const before = console.log;
  const pg = createProgress({ total: 2, label: 't', stream });
  console.log('hello', 1);
  pg.tick('ok'); pg.tick('ok');
  pg.done();
  assert.equal(console.log, before);
  assert.ok(lines.some((l) => l.includes('hello 1')));
  assert.ok(lines.some((l) => /finished 2\/2/.test(l)));
});

test('in a terminal the bar is redrawn under each log line and cleared at the end', () => {
  const out = []; const stream = { isTTY: true, columns: 100, write: (s) => out.push(s) };
  const pg = createProgress({ total: 2, label: 'p', stream, width: 4 });
  pg.start(); pg.log('[1/2] A pass'); pg.tick('pass');
  const joined = out.join('');
  assert.ok(joined.includes('\r\x1b[2K'), 'clears the line before writing');
  assert.ok(joined.includes('[1/2] A pass\n'));
  assert.ok(/p ██░░ 1\/2 50\.0%/.test(joined));
  pg.done();
  assert.ok(out.at(-1).includes('finished 1/2'));
});

import { progress as mineProgressLine, fail as mineFailLine } from '../lib/progress.mjs';
test('mine protocol lines go to stderr only when MINE_PROGRESS=1', () => {
  const writes = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { writes.push(String(s)); return true; };
  try {
    delete process.env.MINE_PROGRESS;
    mineProgressLine(1, 4, 'a'); mineFailLine('a', 'boom');
    assert.equal(writes.length, 0);
    process.env.MINE_PROGRESS = '1';
    mineProgressLine(2, 4, 'jobs:x'); mineFailLine('jobs:x', 'bad\nthing');
  } finally { process.stderr.write = orig; delete process.env.MINE_PROGRESS; }
  assert.deepEqual(writes, ['@@PROGRESS 2/4 jobs:x\n', '@@FAIL jobs:x\tbad thing\n']);
});
