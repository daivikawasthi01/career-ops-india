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
  assert.ok(PASSING.has('jobs-found') && PASSING.has('listings-on-page') && !PASSING.has('listings-unread') && !PASSING.has('board-empty'));
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

test('the first query is the quoted name; the retry queries ask for India', () => {
  assert.ok(queryPair('Zepto', {}, 0)[0] === '"Zepto" careers');
  assert.ok(queryPair('Zepto', {}, 1).every((q) => /india/i.test(q)));
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

import { slugMatchesName } from '../lib/board-audit.mjs';
import { jobsFromJson, bestJsonJobs, nameInHost, identityOk, indiaFilterLinks } from '../lib/careers-pass2.mjs';

test('jobsFromJson finds job arrays in common API shapes and counts India', () => {
  const gh = { jobs: [{ id: 1, title: 'Software Engineer', location: { name: 'Bengaluru, India' } }, { id: 2, title: 'Data Analyst', location: { name: 'Berlin' } }, { id: 3, title: 'DevOps Engineer', location: { name: 'Pune' } }] };
  const r = jobsFromJson(gh);
  assert.equal(r.count, 3);
  assert.equal(r.india, 2);
  assert.deepEqual(r.sample.slice(0, 1), ['Software Engineer']);
  assert.equal(jobsFromJson({ items: [{ name: 'a' }, { name: 'b' }] }), null, 'not job-like');
  assert.equal(jobsFromJson({ jobs: [{ title: 'Software Engineer', id: 1 }, { title: 'QA Engineer', id: 2 }] }), null, 'fewer than three');
  assert.equal(bestJsonJobs([null, { count: 2 }, { count: 9 }]).count, 9);
});

test('identity: the company name in the host, a trusted site, or a matching ATS slug; a lookalike does not pass', () => {
  const atsOf = (u) => (/greenhouse\.io\/([a-z0-9-]+)/.exec(u) ? { ats: 'greenhouse', tenant: /greenhouse\.io\/([a-z0-9-]+)/.exec(u)[1] } : null);
  const slugOk = slugMatchesName;
  const none = new Set();
  assert.equal(identityOk('https://www.hirezapp.com/careers/zepto/jobs', 'Zepto', none, atsOf, slugOk), false);
  assert.equal(identityOk('https://www.zepto.com/s/careers', 'Zepto', none, atsOf, slugOk), true);
  assert.equal(identityOk('https://job-boards.greenhouse.io/tide', 'TIDE', none, atsOf, slugOk), true);
  assert.equal(identityOk('https://job-boards.greenhouse.io/swiggytech', 'Swiggy', none, atsOf, slugOk), true, 'a longer name may match by prefix');
  assert.equal(identityOk('https://job-boards.greenhouse.io/arcgames', 'Arc', none, atsOf, slugOk), false);
  assert.equal(identityOk('https://careers.example.org/', 'Acme', new Set(['example.org']), atsOf, slugOk), true, 'a trusted site');
  assert.ok(nameInHost('https://careers.wipro.com', 'Wipro'));
});

test('india filter links: query values, path segments, and short India link texts on the same site', () => {
  const links = [
    { href: 'https://jobs.x.com/search?location=India', text: 'India' },
    { href: 'https://jobs.x.com/en-in/search', text: 'Search jobs' },
    { href: 'https://jobs.x.com/search?country=US', text: 'United States' },
    { href: 'https://other.com/jobs?location=India', text: 'India' },
    { href: 'https://jobs.x.com/about', text: 'About' },
  ];
  assert.deepEqual(indiaFilterLinks(links, 'x.com').map((l) => l.href), ['https://jobs.x.com/search?location=India', 'https://jobs.x.com/en-in/search']);
});

import { indiaStatus, guessCareerUrls, isIndiaLoc } from '../lib/careers-pass2.mjs';

test('listings with locations read and none in India are right-portal-no-india; without locations they are india-unknown', () => {
  assert.equal(indiaStatus('jobs-found', { total: 80, india: 0 }), 'right-portal-no-india');
  assert.equal(indiaStatus('jobs-found', { total: 80, india: 5 }), 'jobs-found');
  assert.equal(indiaStatus('listings-on-page', { total: 14, located: 14, india: 0 }), 'right-portal-no-india');
  assert.equal(indiaStatus('listings-on-page', { total: 14, located: 0, india: 0 }), 'india-unknown');
  assert.equal(indiaStatus('listings-on-page', { total: 11 }), 'india-unknown');
  assert.equal(indiaStatus('listings-on-page', { total: 9, located: 9, india: 2 }), 'listings-on-page');
});

test('India locations are recognised in odd spellings', () => {
  for (const l of ['Bangalore', 'BLR', 'Gurgaon/Gurugram', 'Hybrid, IN', 'Delhi NCR', 'IN-KA', 'Kochi, Kerala']) assert.ok(isIndiaLoc(l), l);
  for (const l of ['Berlin', 'Remote', 'Indianapolis', 'In person', 'Austin, TX']) assert.ok(!isIndiaLoc(l), l);
});

test('a site menu or product list in page JSON is not a job list, and a soft 404 is not a careers page', () => {
  const menu = { nav: [{ name: 'romance', id: 1, url: '/romance' }, { name: 'party wear', id: 2, url: '/pw' }, { name: 'festive', id: 3, url: '/f' }, { name: 'weekend', id: 4, url: '/w' }] };
  assert.equal(jobsFromJson(menu), null);
  const jobs = { items: [{ title: 'Backend Engineer', id: 1, location: 'Pune' }, { title: 'Data Analyst', id: 2, location: 'Remote' }, { title: 'Product Designer', id: 3, location: 'Delhi' }] };
  assert.equal(jobsFromJson(jobs).count, 3);
  const links = Array.from({ length: 6 }, (_, i) => ({ href: `https://x.com/jobs/${i}`, text: `Software Engineer ${i}` }));
  assert.equal(classifyPage({ status: 200, text: 'Whoopsie Daisy | We could not find what you are looking for. | CONTINUE SHOPPING', links }).verdict, 'not-careers');
  assert.equal(classifyPage({ status: 200, text: 'Careers | open positions', links }).verdict, 'listings-on-page');
});

import { HIRING_SIGNAL, visionListingsOk } from '../lib/careers-pass2.mjs';
test('screenshot readings count only when they name job-title-like items', () => {
  assert.equal(visionListingsOk({ shows_job_listings: true, job_titles: ['romance', 'party wear', 'festive'], locations: [] }), null);
  assert.equal(visionListingsOk({ shows_job_listings: false, job_titles: ['Software Engineer', 'Data Analyst', 'QA Tester'] }), null);
  const r = visionListingsOk({ shows_job_listings: true, job_titles: ['Software Engineer', 'Data Analyst', 'Retail Manager'], locations: ['Mumbai', 'Remote', 'Pune'] });
  assert.deepEqual([r.count, r.located, r.india], [3, 3, 2]);
});
test('hiring signal: an about-us page titled Career does not have it, a real careers page does', () => {
  assert.ok(!HIRING_SIGNAL.test('Career | BlueStone.com About Us Established in 2011, BlueStone is India\'s leading destination for fine jewellery'));
  for (const t of ['Current openings', 'Join our team', 'We are hiring', 'Apply now', 'email careers@x.com', 'View all jobs']) assert.ok(HIRING_SIGNAL.test(t), t);
});

import { OPEN_ROLES_RE } from '../tools/discover-careers.mjs';
test('open-roles button text is recognised, apply-style buttons are not', () => {
  for (const t of ['Show open roles', 'View all jobs', 'See open positions', 'Explore openings', 'Open Roles', 'View current openings →']) assert.ok(OPEN_ROLES_RE.test(t), t);
  for (const t of ['Apply now', 'Open menu', 'Show more', 'Jobs', 'Sign in']) assert.ok(!OPEN_ROLES_RE.test(t), t);
});

import { indiaTenantVariants, siblingTenant } from '../lib/careers-pass2.mjs';
import { atsFromUrl as atsFromUrl3 } from '../lib/careers-discovery.mjs';
test('ats sibling India boards: tenant gets an india suffix, nothing else changes', () => {
  assert.deepEqual(indiaTenantVariants('https://job-boards.greenhouse.io/razorpay', atsFromUrl3), ['https://job-boards.greenhouse.io/razorpayindia', 'https://job-boards.greenhouse.io/razorpay-india', 'https://job-boards.greenhouse.io/razorpayin']);
  assert.equal(indiaTenantVariants('https://jobs.lever.co/eternal', atsFromUrl3)[1], 'https://jobs.lever.co/eternal-india');
  assert.deepEqual(indiaTenantVariants('https://example.com/careers', atsFromUrl3), []);
  assert.ok(siblingTenant('https://job-boards.greenhouse.io/blenheimchalcot', 'https://job-boards.greenhouse.io/blenheimchalcotindia', atsFromUrl3));
  assert.ok(!siblingTenant('https://job-boards.greenhouse.io/razorpay', 'https://job-boards.greenhouse.io/razorpayx', atsFromUrl3));
  assert.ok(!siblingTenant('https://job-boards.greenhouse.io/a', 'https://jobs.lever.co/aindia', atsFromUrl3));
});

test('guessed careers URLs come only from a plausible host', () => {
  assert.ok(guessCareerUrls('www.slice.bank.in').includes('https://careers.slice.bank.in'));
  assert.deepEqual(guessCareerUrls(''), []);
  assert.deepEqual(guessCareerUrls('not a host'), []);
});

import { isHollowResults } from '../tools/discover-careers.mjs';
test('search rows with links but no titles are hollow, real result rows are not', () => {
  assert.equal(isHollowResults(Array.from({ length: 10 }, () => ({ title: '', url: 'https://x.com' }))), true);
  assert.equal(isHollowResults([{ title: 'Careers - Zepto' }, { title: 'Zepto: Jobs | LinkedIn' }, { title: 'Zepto Careers' }, { title: '' }]), false);
  assert.equal(isHollowResults([]), false);
  assert.equal(isHollowResults([{ title: 'Only one real title' }]), false);
});
