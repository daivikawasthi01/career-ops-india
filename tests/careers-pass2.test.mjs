import { test } from 'node:test';
import { queryPair } from '../lib/careers-pipeline.mjs';
import assert from 'node:assert/strict';
import { classifyPage, jobLinks, followLinks, best, rankCandidates, mark, seen, shouldStop, looksBotBlocked, visionAction, PASSING } from '../lib/careers-pass2.mjs';

const L = (text, href) => ({ text, href });

test('classifyPage: listings, empty board, landing, not a careers page, bot block', () => {
  const jobs = [L('Software Engineer, Backend', 'https://x.com/jobs/1'), L('Data Analyst', 'https://x.com/jobs/2'), L('DevOps Engineer', 'https://x.com/jobs/3')];
  assert.equal(classifyPage({ text: 'Careers at X', links: jobs }).verdict, 'listings-on-page');
  assert.equal(classifyPage({ text: 'Join us. There are no open positions right now.', links: [] }).verdict, 'board-empty');
  assert.equal(classifyPage({ text: 'Careers. We are hiring! View all jobs below.', links: [L('View all jobs', 'https://x.com/jobs')] }).verdict, 'landing');
  assert.equal(classifyPage({ text: 'Laundry detergent and fabric care products', links: [] }).verdict, 'not-careers');
  assert.equal(classifyPage({ status: 403, text: 'x', links: [] }).verdict, 'bot-blocked');
  assert.equal(classifyPage({ text: 'Access Denied. You don\'t have permission to access this server.', links: [] }).verdict, 'bot-blocked');
  assert.ok(!looksBotBlocked({ status: 200, text: 'x'.repeat(3000) + ' captcha' }), 'a long page mentioning captcha is not a block');
});

test('a few navigation links are not listings; duplicates count once', () => {
  assert.equal(jobLinks([L('Careers', 'https://x.com/careers'), L('About', 'https://x.com/about')]).length, 0);
  const dup = [L('Software Engineer', 'https://x.com/jobs/1'), L('Software Engineer', 'https://x.com/jobs/1#a')];
  assert.equal(jobLinks(dup).length, 1);
});

test('followLinks picks the open-positions style links only', () => {
  const f = followLinks([L('Open positions', 'https://x.com/open'), L('Blog', 'https://x.com/blog'), L('View all jobs', 'https://x.com/jobs')], 'x.com');
  assert.deepEqual(f.map((x) => x.href), ['https://x.com/open', 'https://x.com/jobs']);
});

test('best verdict wins; only jobs-found and listings-on-page pass', () => {
  assert.equal(best(['not-careers', 'landing', 'bot-blocked']), 'landing');
  assert.equal(best(['bot-blocked', 'jobs-found']), 'jobs-found');
  assert.equal(best([]), 'not-careers');
  assert.ok(PASSING.has('jobs-found') && PASSING.has('listings-unread') && !PASSING.has('board-empty'));
});

test('candidates: tried URLs, search engines and job aggregators are dropped, careers-looking own-site first', () => {
  const tried = new Map(); mark(tried, 'https://www.acme.com/careers/', 'not-careers');
  const results = [
    { url: 'https://www.acme.com/careers', title: 'Careers' },
    { url: 'https://www.linkedin.com/company/acme/jobs', title: 'Acme jobs' },
    { url: 'https://www.bing.com/x', title: 'x' },
    { url: 'https://acme.com/about', title: 'About' },
    { url: 'https://boards.greenhouse.io/acme', title: 'Acme jobs' },
    { url: 'https://other.com/news', title: 'Acme news' },
    { url: 'https://forum.example.com/threads/1', title: 'what are you watching' },
  ];
  assert.ok(seen(tried, 'https://acme.com/careers'));
  const r = rankCandidates(results, tried, { companyHost: 'acme.com', name: 'Acme' });
  assert.deepEqual(r.map((x) => x.url), ['https://boards.greenhouse.io/acme', 'https://acme.com/about']);
});

test('the loop always ends: pass, round cap, test cap, or a round with nothing new', () => {
  assert.equal(shouldStop({ round: 1, tests: 3, newCandidates: 2, passed: false }), false);
  assert.equal(shouldStop({ round: 1, tests: 3, newCandidates: 2, passed: true }), true);
  assert.equal(shouldStop({ round: 3, tests: 3, newCandidates: 2, passed: false }), true);
  assert.equal(shouldStop({ round: 1, tests: 12, newCandidates: 2, passed: false }), true);
  assert.equal(shouldStop({ round: 1, tests: 3, newCandidates: 0, passed: false }), true);
});

test('vision states map to actions', () => {
  assert.equal(visionAction({ state: 'captcha' }), 'search-blocked');
  assert.equal(visionAction({ state: 'results' }), 'read-urls');
  assert.equal(visionAction({ state: 'consent' }), 'retry');
  assert.equal(visionAction(null), 'none');
});

test('every search query asks for India', () => {
  for (const pass of [0, 1]) for (const q of queryPair('Zepto', {}, pass)) assert.match(q, /india/i);
});

import { indiaVariants, sameOwner, pass3Decision } from '../lib/careers-pass2.mjs';
import { atsFromUrl } from '../lib/careers-discovery.mjs';

test('india variants: locale segments swap, params swap, otherwise prefixes', () => {
  assert.deepEqual(indiaVariants('https://www.apple.com/careers/us/'), ['https://www.apple.com/careers/in/', 'https://www.apple.com/careers/en-in/']);
  assert.equal(indiaVariants('https://x.com/en-us/careers')[0], 'https://x.com/en-in/careers');
  assert.equal(indiaVariants('https://x.com/careers?country=US')[0], 'https://x.com/careers?country=IN');
  const plain = indiaVariants('https://x.com/careers');
  assert.ok(plain.includes('https://x.com/in/careers') && plain.includes('https://in.x.com/careers'));
  assert.ok(plain.length <= 6 && !plain.includes('https://x.com/careers'));
  assert.deepEqual(indiaVariants('not a url'), []);
});

test('only the same site or the same ATS tenant may replace a portal', () => {
  assert.ok(sameOwner('https://www.apple.com/careers/us/', 'https://jobs.apple.com/en-in/search', atsFromUrl));
  assert.ok(!sameOwner('https://www.apple.com/careers/us/', 'https://www.other.com/careers/in/', atsFromUrl));
  assert.ok(sameOwner('https://boards.greenhouse.io/acme', 'https://job-boards.greenhouse.io/acme', atsFromUrl));
  assert.ok(!sameOwner('https://boards.greenhouse.io/acme', 'https://boards.greenhouse.io/other', atsFromUrl));
});

test('pass 3 switches only for India postings the old page lacks', () => {
  assert.equal(pass3Decision({ oldIndia: 0, candidate: { verdict: 'jobs-found', india: 12 } }), 'switch');
  assert.equal(pass3Decision({ oldIndia: 0, candidate: { verdict: 'jobs-found', india: 0 } }), 'keep');
  assert.equal(pass3Decision({ oldIndia: 3, candidate: { verdict: 'jobs-found', india: 3 } }), 'keep');
  assert.equal(pass3Decision({ oldIndia: 0, candidate: { verdict: 'listings-on-page', indiaMentions: 4 } }), 'switch');
  assert.equal(pass3Decision({ oldIndia: 0, candidate: null }), 'none-found');
});
