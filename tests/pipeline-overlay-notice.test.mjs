// The filter overlay must never be skipped silently, and a data root outside the repo must warn.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyPipelineConfig, dataRootOutsideRepo, warnIfDataRootOutsideRepo, resetPipelineConfigNotices,
} from '../lib/pipeline-config.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const pipeline = { title_filter: { positive: ['intern'], negative: [] } };
const portals = () => ({ title_filter: { positive: ['own'], negative: [] }, title_filter_full: { x: 1 } });

beforeEach(() => resetPipelineConfigNotices());

test('a foreign data root skips the overlay, keeps its own filter, and logs one line saying why', () => {
  const lines = [];
  const env = { CAREER_OPS_ROOT: join(tmpdir(), 'other-profile') };
  const cfg = applyPipelineConfig(portals(), pipeline, { env, log: (m) => lines.push(m) });
  applyPipelineConfig(portals(), pipeline, { env, log: (m) => lines.push(m) });
  assert.deepEqual(cfg.title_filter.positive, ['own']);
  const skips = lines.filter((l) => /overlay SKIPPED/.test(l));
  assert.equal(skips.length, 1, 'logged once per process, not once per call');
  assert.match(skips[0], /CAREER_OPS_PIPELINE_CONFIG/);
  assert.match(skips[0], /other-profile/);
});

test('the same root with CAREER_OPS_PIPELINE_CONFIG set applies the overlay and does not log a skip', () => {
  const lines = [];
  const env = { CAREER_OPS_ROOT: join(tmpdir(), 'other-profile'), CAREER_OPS_PIPELINE_CONFIG: '/x/pipeline.yml' };
  const cfg = applyPipelineConfig(portals(), pipeline, { env, log: (m) => lines.push(m) });
  assert.deepEqual(cfg.title_filter.positive, ['intern']);
  assert.equal(cfg.title_filter_full, undefined);
  assert.ok(!lines.some((l) => /SKIPPED/.test(l)));
});

test('the repo as its own data root applies the overlay silently', () => {
  const lines = [];
  const cfg = applyPipelineConfig(portals(), pipeline, { env: {}, log: (m) => lines.push(m) });
  assert.deepEqual(cfg.title_filter.positive, ['intern']);
  assert.deepEqual(lines, []);
});

test('a missing pipeline.yml is reported, not skipped quietly', () => {
  const lines = [];
  const cfg = applyPipelineConfig(portals(), null, { env: {}, log: (m) => lines.push(m) });
  assert.deepEqual(cfg.title_filter.positive, ['own']);
  assert.equal(lines.filter((l) => /overlay SKIPPED.*not found/.test(l)).length, 1);
});

test('CAREER_OPS_ROOT outside the repo warns at startup; inside or unset does not', () => {
  assert.equal(dataRootOutsideRepo({ CAREER_OPS_ROOT: '/somewhere/else' }, REPO), true);
  assert.equal(dataRootOutsideRepo({ CAREER_OPS_ROOT: join(REPO, 'data') }, REPO), false);
  assert.equal(dataRootOutsideRepo({ CAREER_OPS_ROOT: REPO }, REPO), false);
  assert.equal(dataRootOutsideRepo({}, REPO), false);
  const lines = [];
  assert.equal(warnIfDataRootOutsideRepo({ env: { CAREER_OPS_ROOT: '/somewhere/else' }, repoRoot: REPO, log: (m) => lines.push(m) }), true);
  assert.match(lines[0], /WARNING: CAREER_OPS_ROOT=\/somewhere\/else is outside the repository/);
  assert.equal(warnIfDataRootOutsideRepo({ env: {}, repoRoot: REPO, log: (m) => lines.push(m) }), false);
});

test('board-india-check run against a foreign root prints both notices on stderr (child process)', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'co-overlay-'));
  try {
    const r = spawnSync(process.execPath, [join(REPO, 'board-india-check.mjs'), '--company', 'Nobody'], {
      encoding: 'utf-8',
      timeout: 20000,
      env: { ...process.env, CAREER_OPS_ROOT: sandbox, CAREER_OPS_PORTALS: join(REPO, 'templates', 'portals.example.yml') },
    });
    assert.match(r.stderr, /WARNING: CAREER_OPS_ROOT=.*outside the repository/);
    assert.match(r.stderr, /overlay SKIPPED/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
