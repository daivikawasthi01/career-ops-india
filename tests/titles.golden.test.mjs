// Golden title set: every labelled row in tests/titles.golden.tsv must come out as labelled
// through the shared pipeline.yml rules (title_filter + batch year). Rows are added when a
// real title is filtered wrongly, so a fix cannot silently regress.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { requirePipelineConfig, buildTitleCheck } from '../lib/pipeline-config.mjs';
import { batchYears } from '../lib/batch-year.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const rows = readFileSync(join(HERE, 'titles.golden.tsv'), 'utf-8').trim().split('\n').slice(1)
  .map((line) => { const [title, expect, reason] = line.split('\t'); return { title, expect, reason }; });

test('golden file is well formed', () => {
  assert.ok(rows.length >= 80 && rows.length <= 110, `expected about 100 rows, got ${rows.length}`);
  for (const r of rows) assert.ok(['keep', 'drop'].includes(r.expect), `bad label for "${r.title}"`);
  assert.equal(new Set(rows.map((r) => r.title)).size, rows.length, 'duplicate titles');
});

test('every golden title is filtered as labelled', () => {
  const check = buildTitleCheck(requirePipelineConfig(), batchYears);
  const wrong = rows
    .filter((r) => (check(r.title).keep ? 'keep' : 'drop') !== r.expect)
    .map((r) => `${r.expect === 'keep' ? 'WRONGLY DROPPED' : 'WRONGLY KEPT'}: ${r.title} (${r.reason})`);
  assert.deepEqual(wrong, []);
});
