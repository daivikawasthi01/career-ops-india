// A board that answers is not proof it belongs to the company. These cases are the real mistakes
// found in portals.yml (Walmart/BambooHR, Vivo/Guatemala, Clay/Dutch hotels, SAIL/Sail Research)
// and the real matches a too-strict check would have thrown away (Bolna AI, Careers at Tide).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nameIdentityVerdict } from '../lib/board-identity-names.mjs';
import {
  boardKey, linkToBoard, extractUrls, siteCandidates, confirmBoardIdentity, gateByIdentity, appendReviewFile, REVIEW_HEADER,
  vendorSlug, loadApproved, appendConfirmedLog, APPROVED_HEADER, CONFIRMED_HEADER,
} from '../lib/board-identity.mjs';

const match = (a, b) => nameIdentityVerdict(a, b).match;

test('careers and legal-form words do not change identity', () => {
  assert.equal(match('Bolna', 'Bolna AI'), true);
  assert.equal(match('HackerRank', 'HackerRank Careers'), true);
  assert.equal(match('TIDE', 'Careers at Tide'), true);
  assert.equal(match('Kestra', 'Kestra Technologies'), true);
  assert.equal(match('Hacker Rank', 'HackerRank'), true);
  assert.equal(match('Acme Pvt Ltd', 'Acme'), true);
});

test('words that name the business still separate companies', () => {
  assert.equal(match('SAIL', 'Sail Research'), false);
  assert.equal(match('Mercury', 'Mercury Systems'), false);
  assert.equal(match('Northrop', 'Northrop Grumman'), false);
  assert.equal(match('Clay', 'Courtyard Amsterdam'), false);
  assert.equal(match('Walmart', 'Walmart Utah Staffing'), false);
});

test('boardKey identifies vendor and tenant, not just a host', () => {
  assert.equal(boardKey('https://boards.greenhouse.io/Acme/jobs/1'), 'greenhouse|acme');
  assert.equal(boardKey('https://job-boards.greenhouse.io/acme'), 'greenhouse|acme');
  assert.equal(boardKey('https://careers.smartrecruiters.com/Shipsy'), 'careers.smartrecruiters.com|shipsy');
  assert.equal(boardKey('https://join.com/companies/novu'), 'join.com|novu');
  assert.equal(boardKey('https://multiplier.bamboohr.com/careers'), 'multiplier.bamboohr.com');
});

test('a link only counts when it names this exact board', () => {
  const urls = extractUrls('<a href="https://jobs.ashbyhq.com/other">x</a> <script>var u="https://boards.greenhouse.io/Acme";</script>');
  assert.ok(linkToBoard(urls, 'https://job-boards.greenhouse.io/acme'));
  assert.equal(linkToBoard(urls, 'https://jobs.ashbyhq.com/acme'), null, 'same vendor, different tenant');
  assert.equal(linkToBoard(['https://www.bamboohr.com/'], 'https://walmart.bamboohr.com'), null);
  assert.ok(linkToBoard(['https://aftershoot.recruitee.com/o/x'], 'https://aftershoot.recruitee.com'));
});

test('site candidates come from the declared website, else the brand as a domain', () => {
  assert.deepEqual(siteCandidates('Acme Technologies', 'https://www.acme.io/about'), ['www.acme.io']);
  assert.deepEqual(siteCandidates('Hacker Rank Careers').slice(0, 2), ['hackerrank.com', 'hackerrank.ai']);
});

// A fake web: url -> html. Anything absent is unreachable.
const web = (pages) => async (url) => { if (url in pages) return pages[url]; throw new Error('unreachable'); };
const json = (map) => async (url) => { if (url in map) return map[url]; throw new Error('404'); };

test('owner-name match confirms: Bolna on Ashby titled "Bolna AI"', async () => {
  const r = await confirmBoardIdentity(
    { name: 'Bolna', careers_url: 'https://jobs.ashbyhq.com/bolna' }, {},
    { fetchText: web({ 'https://jobs.ashbyhq.com/bolna': '<title>Bolna AI Jobs</title>' }), fetchJson: json({}) });
  assert.equal(r.status, 'confirmed');
  assert.equal(r.via, 'name');
});

test('owner-name match confirms: TIDE on Greenhouse titled "Careers at Tide"', async () => {
  const r = await confirmBoardIdentity(
    { name: 'TIDE', careers_url: 'https://job-boards.greenhouse.io/tide' }, {},
    { fetchText: web({}), fetchJson: json({ 'https://boards-api.greenhouse.io/v1/boards/tide': { name: 'Careers at Tide' } }) });
  assert.equal(r.status, 'confirmed');
});

test('SAIL on Ashby owned by "Sail Research" goes to review', async () => {
  const r = await confirmBoardIdentity(
    { name: 'SAIL', careers_url: 'https://jobs.ashbyhq.com/sail' }, {},
    { fetchText: web({ 'https://jobs.ashbyhq.com/sail': '<title>Sail Research Jobs</title>', 'https://sail.com/': '<a href="https://sail.com/about">About</a>' }), fetchJson: json({}) });
  assert.equal(r.status, 'review');
  assert.match(r.reason, /Sail Research/);
});

test('Walmart on BambooHR goes to review: walmart.com does not link to that tenant', async () => {
  const r = await confirmBoardIdentity(
    { name: 'Walmart', careers_url: 'https://walmart.bamboohr.com' }, {},
    { fetchText: web({ 'https://walmart.com/': '<a href="https://careers.walmart.com">Careers</a>', 'https://walmart.com/careers': '<a href="https://careers.walmart.com/results">jobs</a>' }), fetchJson: json({}) });
  assert.equal(r.status, 'review');
  assert.match(r.reason, /no owner endpoint/);
});

test('Vivo on BambooHR goes to review: the phone maker links to its own careers site', async () => {
  const r = await confirmBoardIdentity(
    { name: 'Vivo', careers_url: 'https://vivo.bamboohr.com' }, {},
    { fetchText: web({ 'https://vivo.com/': '<a href="https://www.vivo.com/in/about-vivo/careers">Careers</a>' }), fetchJson: json({}) });
  assert.equal(r.status, 'review');
});

test('Clay on Recruitee (a Dutch hotel board) goes to review', async () => {
  const r = await confirmBoardIdentity(
    { name: 'Clay', careers_url: 'https://clay.recruitee.com' }, {},
    { fetchText: web({ 'https://clay.com/': '<a href="https://jobs.ashbyhq.com/claylabs">Careers</a>' }), fetchJson: json({}) });
  assert.equal(r.status, 'review');
});

test('a board with no owner endpoint is confirmed when the company site links to it', async () => {
  const r = await confirmBoardIdentity(
    { name: 'Aftershoot', careers_url: 'https://aftershoot.recruitee.com' }, { website: 'https://aftershoot.com' },
    { fetchText: web({ 'https://aftershoot.com/': '<a href="/x">x</a>', 'https://aftershoot.com/careers': '<a href="https://aftershoot.recruitee.com/">Open roles</a>' }), fetchJson: json({}) });
  assert.equal(r.status, 'confirmed');
  assert.equal(r.via, 'website');
});

test('gateByIdentity: only confirmed boards pass, the rest are returned for review and never dropped', async () => {
  const resolved = [
    { name: 'Bolna', vendor: 'ashby', careers_url: 'https://jobs.ashbyhq.com/bolna', jobCount: 6 },
    { name: 'Walmart', vendor: 'bamboohr', careers_url: 'https://walmart.bamboohr.com', jobCount: 9 },
  ];
  const { confirmed, review } = await gateByIdentity(resolved, [], {
    fetchText: web({ 'https://jobs.ashbyhq.com/bolna': '<title>Bolna AI Jobs</title>' }), fetchJson: json({}),
  });
  assert.deepEqual(confirmed.map((b) => b.name), ['Bolna']);
  assert.deepEqual(review.map((b) => b.name), ['Walmart']);
  assert.equal(confirmed.length + review.length, resolved.length);
});

test('the review file has a header, one line per board, and ignores a board already listed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-review-'));
  try {
    const path = join(dir, 'data', 'discovery-review.tsv');
    const item = { name: 'Walmart', vendor: 'bamboohr', careers_url: 'https://walmart.bamboohr.com', jobCount: 9, identity: { reason: 'no owner\tendpoint', owner: undefined } };
    assert.equal(appendReviewFile(path, [item], '2026-11-09', fs), 1);
    assert.equal(appendReviewFile(path, [item], '2026-11-10', fs), 0);
    const lines = readFileSync(path, 'utf-8').replace(/\n$/, '').split('\n');
    assert.equal(lines[0], REVIEW_HEADER);
    assert.equal(lines.length, 2);
    assert.equal(lines[1].split('\t').length, REVIEW_HEADER.split('\t').length, 'a tab inside a value cannot add a column');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vendorSlug reads the board out of tenant hosts and path-tenant hosts', () => {
  assert.deepEqual(vendorSlug('https://careers.smartrecruiters.com/Shipsy'), { ats: 'smartrecruiters', slug: 'shipsy' });
  assert.deepEqual(vendorSlug('https://ats.rippling.com/everstage/jobs'), { ats: 'rippling', slug: 'everstage' });
  assert.deepEqual(vendorSlug('https://aftershoot.recruitee.com/'), { ats: 'recruitee', slug: 'aftershoot' });
  assert.deepEqual(vendorSlug('https://join.com/companies/novu'), { ats: 'join', slug: 'novu' });
  assert.deepEqual(vendorSlug('https://job-boards.greenhouse.io/Tide'), { ats: 'greenhouse', slug: 'tide' });
});

test('a board listed in identity-approved.tsv passes, and is recorded as approved, not name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-approved-'));
  try {
    const path = join(dir, 'identity-approved.tsv');
    fs.writeFileSync(path, `${APPROVED_HEADER}\nShipsy\tsmartrecruiters\tshipsy\tchecked by hand\n`);
    const approved = loadApproved(path, fs);
    assert.equal(loadApproved(join(dir, 'missing.tsv'), fs).size, 0, 'no file approves nothing');
    const io = { fetchText: web({}), fetchJson: json({}), approved };
    const ok = await confirmBoardIdentity({ name: 'Shipsy', careers_url: 'https://careers.smartrecruiters.com/Shipsy' }, {}, io);
    assert.equal(ok.status, 'confirmed');
    assert.equal(ok.via, 'approved');
    assert.equal(ok.employerConfirmed, true);
    const other = await confirmBoardIdentity({ name: 'Walmart', careers_url: 'https://walmart.bamboohr.com' }, {}, io);
    assert.equal(other.status, 'review', 'only the listed board is approved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a name-only pass is labelled as such and is not employer-confirmed', async () => {
  const r = await confirmBoardIdentity(
    { name: 'Ghost', careers_url: 'https://jobs.ashbyhq.com/ghost' }, {},
    { fetchText: web({ 'https://jobs.ashbyhq.com/ghost': '<title>Ghost Jobs</title>' }), fetchJson: json({}) });
  assert.equal(r.status, 'confirmed');
  assert.equal(r.via, 'name');
  assert.equal(r.employerConfirmed, false);
});

test('the confirmation log records how each board was confirmed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-conflog-'));
  try {
    const path = join(dir, 'data', 'identity-log.tsv');
    const rows = [
      { name: 'Bolna', careers_url: 'https://jobs.ashbyhq.com/bolna', identity: { via: 'name', employerConfirmed: false, reason: 'owner matches' } },
      { name: 'Shipsy', careers_url: 'https://careers.smartrecruiters.com/shipsy', identity: { via: 'approved', employerConfirmed: true, reason: 'listed' } },
    ];
    assert.equal(appendConfirmedLog(path, rows, '2026-11-09', fs), 2);
    const lines = readFileSync(path, 'utf-8').replace(/\n$/, '').split('\n');
    assert.equal(lines[0], CONFIRMED_HEADER);
    assert.deepEqual(lines.slice(1).map((l) => l.split('\t').slice(1, 6)), [
      ['Bolna', 'ashby', 'bolna', 'name', 'no'],
      ['Shipsy', 'smartrecruiters', 'shipsy', 'approved', 'yes'],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
