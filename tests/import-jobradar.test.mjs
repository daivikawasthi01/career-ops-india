import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { ROOT, NODE } from './helpers.mjs';
import { boardKey, parseCompaniesCsv, toMatches, plan, renderTagged } from '../import-jobradar.mjs';

const CSV = `# name,ats,slug,tier
# comment
name,ats,slug,tier
Stripe,greenhouse,stripe,1
Acme Labs,ashby,acmelabs,2
Zed,lever,zed,2
Pay Co,smartrecruiters,payco,3
Weird,workday,weird,2
Bad Slug,greenhouse,bad slug,2
Stripe Again,greenhouse,Stripe,2
`;

test('parseCompaniesCsv skips comment lines and reads the header', () => {
  const rows = parseCompaniesCsv(CSV);
  assert.equal(rows.length, 7);
  assert.deepEqual(rows[0], { name: 'Stripe', ats: 'greenhouse', slug: 'stripe', tier: '1' });
});

test('toMatches reports unsupported ats and bad slugs instead of dropping them silently', () => {
  const { matches, invalid } = toMatches(parseCompaniesCsv(CSV));
  assert.equal(matches.length, 5);
  assert.deepEqual(invalid.map((i) => i.name).sort(), ['Bad Slug', 'Weird']);
  assert.equal(matches[0].careers_url, 'https://job-boards.greenhouse.io/stripe');
  assert.equal(matches[0].api, 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs');
});

test('boardKey treats the old and new greenhouse hosts and the api as one board', () => {
  assert.equal(boardKey('https://boards.greenhouse.io/Stripe'), 'greenhouse:stripe');
  assert.equal(boardKey('https://job-boards.greenhouse.io/stripe/jobs/1'), 'greenhouse:stripe');
  assert.equal(boardKey('https://boards-api.greenhouse.io/v1/boards/stripe/jobs'), 'greenhouse:stripe');
  assert.equal(boardKey('https://api.lever.co/v0/postings/zed?mode=json'), 'lever:zed');
  assert.equal(boardKey('https://example.com/careers'), null);
});

test('plan skips boards already in portals.yml by name, by url, and by ats+slug, and repeats inside the file', () => {
  const { matches } = toMatches(parseCompaniesCsv(CSV));
  const existing = [
    { name: 'Stripe Inc', careers_url: 'https://boards.greenhouse.io/stripe' }, // same board, other host and name
    { name: 'Zed', careers_url: 'https://example.com/jobs' },                  // same name
  ];
  const { fresh, duplicates } = plan(matches, existing);
  assert.deepEqual(fresh.map((f) => f.name).sort(), ['Acme Labs', 'Pay Co']);
  assert.equal(duplicates.length, 3); // Stripe, Stripe Again, Zed
});

test('renderTagged adds source: jobradar and the output still parses as yaml', () => {
  const text = renderTagged({ name: 'Acme Labs', careers_url: 'https://jobs.ashbyhq.com/acmelabs' });
  const [entry] = yaml.load(`tracked_companies:${text}`).tracked_companies;
  assert.equal(entry.source, 'jobradar');
  assert.equal(entry.enabled, true);
});

test('--write adds new boards, keeps the file valid, and leaves a backup; preview writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'import-jobradar-'));
  try {
    const portals = join(dir, 'portals.yml');
    const csv = join(dir, 'companies.csv');
    const original = '# my file\ntracked_companies:\n  - name: Existing\n    careers_url: https://jobs.lever.co/existing\n    enabled: true\njob_boards: []\n';
    writeFileSync(portals, original);
    writeFileSync(csv, CSV);
    const env = { ...process.env, CAREER_OPS_PORTALS: portals };
    const run = (...a) => execFileSync(NODE, [join(ROOT, 'import-jobradar.mjs'), '--csv', csv, ...a], { env, encoding: 'utf8' });

    run();
    assert.equal(readFileSync(portals, 'utf8'), original, 'preview must not write');

    run('--write', '--force');
    const after = yaml.load(readFileSync(portals, 'utf8'));
    assert.equal(after.tracked_companies.length, 1 + 4); // Existing + Stripe, Acme, Zed, Pay Co
    assert.ok(after.tracked_companies.filter((e) => e.source === 'jobradar').length === 4);
    assert.ok(readFileSync(portals, 'utf8').startsWith('# my file\n'), 'comments kept');
    assert.ok(readdirSync(dir).some((f) => f.startsWith('portals.yml.bak-')), 'backup sits beside the portals file');

    const second = run('--write', '--force');
    assert.match(second, /Nothing to add/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
