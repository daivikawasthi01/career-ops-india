import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { jsonPathArg, plainOffer, writeJsonFile } from '../lib/json-out.mjs';

test('--json path is read only when a value follows', () => {
  assert.equal(jsonPathArg(['--dry-run', '--json', 'out.json']), 'out.json');
  assert.equal(jsonPathArg(['--json=out.json']), 'out.json');
  assert.equal(jsonPathArg(['--json']), null);
  assert.equal(jsonPathArg(['--json', '--dry-run']), null);
  assert.equal(jsonPathArg([]), null);
});

test('plainOffer keeps the five fields and a posted date', () => {
  const o = plainOffer({ url: 'https://a', title: 'T', company: 'C', location: null, postedAt: '2026-11-01T10:00:00Z', extra: 1 }, 'ats');
  assert.deepEqual(o, { url: 'https://a', title: 'T', company: 'C', location: '', source: 'ats', posted: '2026-11-01' });
});

test('writeJsonFile writes valid JSON and leaves no temp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jo-'));
  const p = join(dir, 'sub', 'o.json');
  writeJsonFile(p, [{ url: 'u' }]);
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf-8')), [{ url: 'u' }]);
});
