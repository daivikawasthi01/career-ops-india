import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  atsFromUrl, findAtsLinks, pickAts, findCampusLink, findCareersLinks, extractUrls, captchaLikely, homepageMatchesCompany,
  hostMatchesCompany, domainCandidates, classify, toRow, readDone, buildInputs, timingReport, TSV_HEADER,
} from '../lib/careers-discovery.mjs';

test('atsFromUrl reads the board out of each supported ATS and rejects vendor roots and embeds', () => {
  assert.deepEqual(atsFromUrl('https://boards.greenhouse.io/razorpay/jobs/123'), { ats: 'greenhouse', tenant: 'razorpay', url: 'https://boards.greenhouse.io/razorpay/jobs/123' });
  assert.equal(atsFromUrl('https://job-boards.greenhouse.io/Razorpay').tenant, 'razorpay');
  assert.equal(atsFromUrl('https://jobs.lever.co/cred/abc').ats, 'lever');
  assert.equal(atsFromUrl('https://jobs.ashbyhq.com/zepto').tenant, 'zepto');
  assert.equal(atsFromUrl('https://acme.wd3.myworkdayjobs.com/en-US/AcmeCareers').tenant, 'acme/acmecareers');
  assert.equal(atsFromUrl('https://acme.darwinbox.in/ms/candidate/careers').ats, 'darwinbox');
  assert.equal(atsFromUrl('https://acme.keka.com/careers').ats, 'keka');
  assert.equal(atsFromUrl('https://acme.zohorecruit.in/jobs/Careers').ats, 'zoho-recruit');
  assert.equal(atsFromUrl('https://acme.freshteam.com/jobs').ats, 'freshteam');
  assert.equal(atsFromUrl('https://boards.greenhouse.io/'), null, 'a vendor root is not a board');
  assert.equal(atsFromUrl('https://boards.greenhouse.io/embed/job_board/js?for=acme'), null);
  assert.equal(atsFromUrl('https://www.keka.com/careers'), null, 'the vendor\'s own site is not a tenant');
  assert.equal(atsFromUrl('mailto:hr@acme.com'), null);
});

test('findAtsLinks dedupes boards and pickAts prefers the one that looks like the company', () => {
  const links = findAtsLinks(['https://jobs.lever.co/othercorp', 'https://boards.greenhouse.io/cred/jobs/1', 'https://boards.greenhouse.io/cred/jobs/2', 'https://x.com']);
  assert.equal(links.length, 2);
  const p = pickAts(links, 'CRED');
  assert.equal(p.best.ats, 'greenhouse');
  assert.equal(p.slugOk, true);
  assert.equal(p.others.length, 1);
  assert.equal(pickAts(findAtsLinks(['https://jobs.lever.co/zzz']), 'CRED').slugOk, false);
  assert.equal(pickAts([], 'CRED').best, null);
});

test('campus, early-careers and internship links are found', () => {
  assert.equal(findCampusLink([{ href: 'https://acme.com/about', text: 'About' }, { href: 'https://acme.com/early-careers', text: 'Students & graduates' }]), 'https://acme.com/early-careers');
  assert.equal(findCampusLink([{ href: 'https://acme.com/x', text: 'Internship program' }]), 'https://acme.com/x');
  assert.equal(findCampusLink([{ href: 'https://acme.com/university-hiring', text: 'Hiring' }]), 'https://acme.com/university-hiring');
  assert.equal(findCampusLink([{ href: 'https://acme.com/about', text: 'About' }, { href: 'https://acme.com/brochure.pdf', text: 'Campus brochure' }]), null);
});

test('careers links must be on the company site (or an ATS)', () => {
  const links = [{ href: 'https://acme.com/careers', text: 'Careers' }, { href: 'https://evil.example/careers', text: 'Careers' }, { href: 'https://jobs.lever.co/acme', text: 'Jobs' }, { href: 'https://careers.acme.com/', text: 'Join us' }];
  assert.deepEqual(findCareersLinks(links, 'www.acme.com'), ['https://acme.com/careers', 'https://jobs.lever.co/acme', 'https://careers.acme.com/']);
});

test('extractUrls finds links in scripts and JSON too', () => {
  assert.ok(extractUrls('<script>var u="https://jobs.lever.co/acme";</script>').includes('https://jobs.lever.co/acme'));
});

test('captcha and rate-limit pages are recognised', () => {
  assert.equal(captchaLikely({ status: 429, html: '' }), true);
  assert.equal(captchaLikely({ status: 200, html: '<title>Just a moment...</title>' }), true);
  assert.equal(captchaLikely({ status: 200, html: '<form>Unusual traffic from your network</form>' }), true);
  assert.equal(captchaLikely({ status: 200, html: '<h1>Careers at Acme</h1>' }), false);
});

test('a guessed domain is accepted only when the homepage names the company', () => {
  assert.equal(homepageMatchesCompany({ title: 'Razorpay: Payments for India', text: '' }, 'Razorpay'), true);
  assert.equal(homepageMatchesCompany({ title: 'Vivo - phones', text: '' }, 'Jar'), false);
  assert.equal(homepageMatchesCompany({ title: 'Home', siteName: 'Jar', text: '' }, 'Jar'), true);
  assert.equal(homepageMatchesCompany({ title: 'Buy domains', text: 'this domain is for sale' }, 'Porter'), false);
});

test('a search result is accepted only when its host belongs to the company', () => {
  assert.equal(hostMatchesCompany('https://careers.razorpay.com/jobs', 'Razorpay', 'razorpay.com'), true);
  assert.equal(hostMatchesCompany('https://www.glassdoor.com/Razorpay', 'Razorpay', 'razorpay.com'), false);
  assert.equal(hostMatchesCompany('https://razorpay.in/careers', 'Razorpay', ''), true);
  assert.equal(hostMatchesCompany('https://naukri.com/razorpay-jobs', 'Razorpay', 'razorpay.com'), false);
});

test('domain candidates put an override first and then the brand on common TLDs', () => {
  const c = domainCandidates('Hacker Rank Careers', { override: 'hackerrank.com' });
  assert.equal(c[0], 'hackerrank.com');
  assert.ok(c.includes('hackerrank.in') && c.includes('hackerrank.co.in'));
  assert.deepEqual(domainCandidates('X!', {}).slice(0, 1), []);
});

test('classify: high only for a verified domain with an ATS link on its own site and a matching tenant', () => {
  const ats = { ats: 'greenhouse', tenant: 'cred', url: 'u' };
  assert.equal(classify({ domain: 'cred.club', domainVerified: true, domainSource: 'guess', ats, slugOk: true, careersUrl: 'u', atsOnOwnSite: true, pagesLoaded: 2 }).confidence, 'high');
  assert.equal(classify({ domain: 'cred.club', domainVerified: true, ats, slugOk: false, careersUrl: 'u', atsOnOwnSite: true, pagesLoaded: 2 }).confidence, 'needs-review');
  assert.equal(classify({ domain: 'cred.club', domainVerified: false, ats, slugOk: true, careersUrl: 'u', atsOnOwnSite: true, pagesLoaded: 2 }).confidence, 'needs-review');
  assert.equal(classify({ domain: 'cred.club', domainVerified: true, ats, slugOk: true, careersUrl: 'u', atsOnOwnSite: false, viaSearch: true, pagesLoaded: 3 }).confidence, 'needs-review');
  assert.equal(classify({ domain: 'a.com', domainVerified: true, ats: null, careersUrl: 'https://a.com/careers', pagesLoaded: 2 }).confidence, 'medium');
  assert.equal(classify({ domain: '', domainVerified: false, ats: null, careersUrl: '', pagesLoaded: 0 }).confidence, 'needs-review');
  assert.equal(classify({ domain: 'a.com', domainVerified: true, ats: null, careersUrl: '', pagesLoaded: 2 }).confidence, 'needs-review');
});

test('rows are flat TSV, and resume reads the companies already written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-careers-'));
  try {
    const path = join(dir, 'careers-discovery.tsv');
    writeFileSync(path, TSV_HEADER + '\n');
    appendFileSync(path, toRow({ company: 'CRED', domain: 'cred.club', careers_url: 'https://x', ats: 'greenhouse', campus_url: '', confidence: 'high', notes: 'a\tb\nc' }) + '\n');
    const line = toRow({ company: 'CRED', domain: '', careers_url: '', ats: '', campus_url: '', confidence: 'needs-review', notes: 'x\ty' });
    assert.equal(line.split('\t').length, 9);
    assert.deepEqual([...readDone(path)], ['cred']);
    assert.equal(readDone(join(dir, 'missing.tsv')).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inputs combine the protected list, watch boards and check-by-hand, deduplicated, with their sources', () => {
  const inputs = buildInputs({
    protectedText: '# c\nTIDE\nSwiggy\n',
    portalsEntries: [{ name: 'Swiggy', watch: true, careers_url: 'https://x' }, { name: 'Groww', watch: true }, { name: 'Plain' }],
    checkByHandText: '# >>> small-boards\n# comment\nGoogle\t1\thttps://g\nSwiggy\t0\thttps://s\n# <<< small-boards\n',
  });
  assert.deepEqual(inputs.map((i) => i.name), ['TIDE', 'Swiggy', 'Groww', 'Google']);
  assert.deepEqual(inputs.find((i) => i.name === 'Swiggy').sources, ['protected', 'watch', 'check-by-hand']);
  assert.equal(inputs.find((i) => i.name === 'Swiggy').entry.careers_url, 'https://x');
  assert.deepEqual(buildInputs({ protectedText: 'TIDE\nSwiggy', only: ['swiggy'] }).map((i) => i.name), ['Swiggy']);
});

test('timing report extrapolates the first companies to the total', () => {
  assert.deepEqual(timingReport([10, 20, 30], 60), { n: 3, avg_seconds: 20, estimated_total_minutes: 20 });
});

test('a short block page counts as a captcha, a long ordinary page that mentions the words does not', () => {
  assert.equal(captchaLikely({ status: 403, html: '<title>Access denied</title><p>blocked</p>' }), true);
  assert.equal(captchaLikely({ status: 200, html: `<h1>Careers</h1>${'<p>Join our team of engineers building great things in India. </p>'.repeat(200)}<p>Access denied to nobody</p>` }), false);
});

test('a company site that blocks us is noted and the verdict stays needs-review', () => {
  const v = classify({ domain: 'tide.com', domainVerified: false, domainSource: 'guess', ats: null, careersUrl: '', pagesLoaded: 1, blocked: ['tide.com'] });
  assert.equal(v.confidence, 'needs-review');
  assert.ok(v.notes.some((n) => /blocked automated access: tide.com/.test(n)));
});

import { applyDecision, buildPrompt, modelName, loadGroqKey, decisionSchema } from '../lib/careers-llm.mjs';

test('llm: the model picks an index from the vetted list, never a URL, and can raise a row to medium at most', () => {
  const cands = ['https://a.com/careers', 'https://boards.greenhouse.io/a', 'https://a.com/campus'];
  const ok = applyDecision({ candidate: 1, is_careers_page: true, ats: 'custom', campus: 2, confidence: 'high', reason: 'jobs board' }, cands);
  assert.equal(ok.confidence, 'medium');
  assert.equal(ok.careers_url, cands[1]);
  assert.equal(ok.ats, 'greenhouse', 'the ATS comes from the URL, not from the model');
  assert.equal(ok.campus_url, cands[2]);
  for (const bad of [null, { candidate: 9, is_careers_page: true, ats: '', campus: null, confidence: 'high', reason: 'x' },
    { candidate: 0, is_careers_page: false, ats: '', campus: null, confidence: 'high', reason: 'x' },
    { candidate: 0, is_careers_page: true, ats: '', campus: null, confidence: 'low', reason: 'x' }]) {
    assert.equal(applyDecision(bad, cands).confidence, 'needs-review');
  }
});

test('llm: the prompt carries only company, domain, title, 30 link texts and numbered candidates', () => {
  const p = buildPrompt({ company: 'A', domain: 'a.com', title: 'Home', linkTexts: Array.from({ length: 50 }, (_, i) => `t${i}`), candidates: ['https://a.com/c'], html: 'SECRET' });
  assert.ok(p.includes('0: https://a.com/c') && p.includes('t29') && !p.includes('t30') && !p.includes('SECRET'));
});

test('llm: model ids need the groq: prefix, and a schema-invalid answer is rejected', () => {
  assert.equal(modelName('groq:openai/gpt-oss-120b'), 'openai/gpt-oss-120b');
  assert.throws(() => modelName('openai/gpt-oss-120b'));
  assert.equal(decisionSchema.safeParse({ candidate: 'one' }).success, false);
});

test('llm: GROQ_API_KEY comes from the environment first, then .env; no key gives an empty string', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-key-'));
  const saved = process.env.GROQ_API_KEY;
  try {
    delete process.env.GROQ_API_KEY;
    assert.equal(loadGroqKey([dir]), '');
    writeFileSync(join(dir, '.env'), 'OTHER=1\nGROQ_API_KEY="gsk_test"\n');
    assert.equal(loadGroqKey([dir]), 'gsk_test');
    process.env.GROQ_API_KEY = 'from-env';
    assert.equal(loadGroqKey([dir]), 'from-env');
  } finally { if (saved === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = saved; rmSync(dir, { recursive: true, force: true }); }
});

test('classify: a custom careers page on a domain we only guessed goes to review', () => {
  assert.equal(classify({ domain: 'cred.co.in', domainVerified: true, domainSource: 'guess', ats: null, careersUrl: 'https://cred.co.in/', pagesLoaded: 2 }).confidence, 'needs-review');
  assert.equal(classify({ domain: 'a.com', domainVerified: true, domainSource: 'override', ats: null, careersUrl: 'https://a.com/careers', pagesLoaded: 2 }).confidence, 'medium');
});
