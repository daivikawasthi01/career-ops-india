import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brandLabel, labelMatchesName, postingDomainMismatch, slugMatchesName, GENERIC_NAMES } from '../lib/board-audit.mjs';
import { writeSection, readSection } from '../lib/check-by-hand.mjs';
import { auditBoard } from '../audit-board-identity.mjs';

test('brandLabel reads the brand out of a host', () => {
  assert.equal(brandLabel('careers.acme.com'), 'acme');
  assert.equal(brandLabel('www.acme.co.in'), 'acme');
  assert.equal(brandLabel('jobs.acme.co.uk'), 'acme');
});

test('slugMatchesName accepts the company, brand extensions and abbreviations, and rejects strangers', () => {
  assert.equal(slugMatchesName('tide', 'TIDE'), true);
  assert.equal(slugMatchesName('hackerrank', 'Hacker Rank'), true);
  assert.equal(slugMatchesName('bounceinsights', 'Bounce'), true);
  assert.equal(slugMatchesName('kestra-io', 'Kestra'), true);
  assert.equal(slugMatchesName('xyzcorp', 'Bounce'), false);
});

test('posting URLs on the employer domain must name the employer; shared ATS hosts are not judged', () => {
  const own = (h, n) => Array.from({ length: n }, (_, i) => `https://${h}/jobs/${i}`);
  assert.equal(postingDomainMismatch('Acme', own('careers.acme.com', 5)).offBrand.length, 0);
  assert.deepEqual(postingDomainMismatch('Acme', own('careers.othercorp.com', 5)).offBrand, ['careers.othercorp.com']);
  const shared = postingDomainMismatch('Acme', own('boards.greenhouse.io', 9));
  assert.equal(shared.judged, false, 'a Greenhouse URL says nothing about the employer');
  assert.equal(postingDomainMismatch('Acme', own('careers.othercorp.com', 2)).judged, false, 'too few to judge');
});

test('the generic-name list from the review is covered', () => {
  for (const n of ['Jar', 'Porter', 'Vogo', 'Bounce', 'Eternal', 'Navi', 'Shine', 'Gramophone', 'Pronto', 'Radix', 'Titan', 'Arc', 'Atlas', 'Make', 'Gamma', 'Mobius', 'Zepto', 'Upstox', 'NoBroker', 'Turtlemint']) {
    assert.ok(GENERIC_NAMES.includes(n), n);
  }
});

const noOwner = async () => { throw new Error('no owner'); };
const siteNo = async () => ({ ok: false });
const siteYes = async () => ({ ok: true });

test('auditBoard: an owner with a different name is flagged', async () => {
  const r = await auditBoard({
    entry: { name: 'SAIL', careers_url: 'https://jobs.ashbyhq.com/sail' }, jobs: [], strict: false, approved: new Set(),
    fetchOwner: async () => '<title>Sail Research Jobs</title>', site: siteNo,
  });
  assert.ok(r.reasons.some((x) => /owner is "Sail Research"/.test(x)));
});

test('auditBoard: a generic name needs the company site, and a name match alone does not clear it', async () => {
  const base = { entry: { name: 'Ghost', careers_url: 'https://job-boards.greenhouse.io/ghost' }, jobs: [], approved: new Set(), fetchOwner: async () => ({ name: 'Ghost' }) };
  const flagged = await auditBoard({ ...base, strict: true, site: siteNo });
  assert.ok(flagged.reasons.some((x) => /name alone is not enough/.test(x)));
  const cleared = await auditBoard({ ...base, strict: true, site: siteYes });
  assert.deepEqual(cleared.reasons, []);
  assert.equal(cleared.how, 'website');
  const approved = await auditBoard({ ...base, strict: true, site: siteNo, approved: new Set(['greenhouse|ghost']) });
  assert.deepEqual(approved.reasons, []);
  assert.equal(approved.how, 'approved');
});

test('auditBoard: slug and posting-domain mismatches are reported, an ordinary matching board is clean', async () => {
  const clean = await auditBoard({ entry: { name: 'Kestra', careers_url: 'https://jobs.ashbyhq.com/kestra' }, jobs: [], strict: false, approved: new Set(), fetchOwner: async () => '<title>Kestra Technologies Jobs</title>', site: siteNo });
  assert.deepEqual(clean.reasons, []);
  const odd = await auditBoard({
    entry: { name: 'Bounce', careers_url: 'https://xyzstaffing.bamboohr.com' },
    jobs: Array.from({ length: 4 }, (_, i) => ({ url: `https://careers.othercorp.com/${i}` })), strict: false, approved: new Set(), fetchOwner: noOwner, site: siteNo,
  });
  assert.ok(odd.reasons.some((x) => /slug "xyzstaffing"/.test(x)));
  assert.ok(odd.reasons.some((x) => /other domains/.test(x)));
});

test('check-by-hand sections replace only their own block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-cbh-'));
  try {
    const path = join(dir, 'data', 'check-by-hand.txt');
    writeSection(path, 'small-boards', ['Google\t1\thttps://x']);
    writeSection(path, 'identity', ['Bounce\thttps://y\twhy']);
    writeSection(path, 'small-boards', ['Uber\t1\thttps://z']);
    assert.deepEqual(readSection(path, 'small-boards'), ['Uber\t1\thttps://z']);
    assert.deepEqual(readSection(path, 'identity'), ['Bounce\thttps://y\twhy']);
    writeSection(path, 'identity', []);
    assert.deepEqual(readSection(path, 'identity'), []);
    assert.ok(readFileSync(path, 'utf-8').includes('Uber'));
    writeFileSync(path, 'hand written line\n');
    writeSection(path, 'identity', ['A\tb\tc']);
    assert.ok(readFileSync(path, 'utf-8').startsWith('hand written line\n'), 'text outside the sections is kept');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
