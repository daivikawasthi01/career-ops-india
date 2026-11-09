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

import { modelName, loadGroqKey, loadModels, domainSchema, verifySchema, domainPrompt, verifyPrompt } from '../lib/careers-llm.mjs';
import {
  registrable, sameSite, isAggregator, classifyFetch, isParked, botWall, checkDomain, quoteInEvidence, checkL1, compareAts,
  boardFingerprint, fingerprintFit, gate, queryVariants, queryPair,
} from '../lib/careers-pipeline.mjs';
import { checkGolden, readGolden, goldenVerdict, tsvRow, COLUMNS } from '../tools/discover-careers.mjs';
import { redact, unwrapBingUrl } from '../lib/careers-pipeline.mjs';
import { parseAggregatorHosts, isAggregatorBoard } from '../lib/board-audit.mjs';
import { auditBoard } from '../audit-board-identity.mjs';
import { readFileSync, readdirSync } from 'node:fs';

test('pipeline: registrable domains and aggregators', () => {
  assert.equal(registrable('www.careers.cred.co.in'), 'cred.co.in');
  assert.equal(registrable('jobs.example.com'), 'example.com');
  assert.ok(sameSite('www.tide.co', 'tide.co') && !sameSite('tide.com', 'tide.co'));
  assert.ok(isAggregator('www.linkedin.com', 'Cred') && !isAggregator('shine.com', 'Shine'));
});

test('pipeline L2: failures are classified and retried with backoff', async () => {
  assert.deepEqual(['404', '403', '429', '503', '200'].map((s) => classifyFetch({ status: Number(s) })), ['404', '403', '429', '5xx', 'ok']);
  assert.equal(classifyFetch({ error: Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }) }), 'dns');
  assert.equal(classifyFetch({ error: new Error('The operation was aborted due to timeout') }), 'timeout');
  assert.ok(isParked('This domain is for sale. Buy this domain today') && !isParked('x'.repeat(200)));
  assert.ok(botWall(403, '') && botWall(200, 'Just a moment...') && !botWall(200, 'hello'));
  let calls = 0; const waits = [];
  const res = (status, url = 'https://a.com/') => ({ status, url, text: async () => 'x'.repeat(300) });
  const flaky = async () => (++calls < 3 ? res(503) : res(200));
  const r = await checkDomain('a.com', { fetchImpl: flaky, lookup: async () => ({}), sleep: async (ms) => waits.push(ms) });
  assert.equal(r.class, 'ok'); assert.equal(r.attempts, 3); assert.deepEqual(waits, [1000, 2000]);
  const dead = await checkDomain('nx.invalid', { fetchImpl: async () => { throw new Error('x'); }, lookup: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); } });
  assert.equal(dead.class, 'dns');
  const away = await checkDomain('cred.co.in', { fetchImpl: async () => res(200, 'https://other-site.com/'), lookup: async () => ({}), sleep: async () => {} });
  assert.ok(away.redirectedAway);
  const gone = await checkDomain('a.com', { fetchImpl: async () => res(404), lookup: async () => ({}), sleep: async () => {} });
  assert.equal(gone.class, '404'); assert.equal(gone.attempts, 1, '404 is not retried');
});

test('pipeline L1: the model may only name an L0 candidate and must quote the text it was shown', () => {
  const cands = [{ domain: 'tide.co' }, { domain: 'tide.com' }];
  const texts = ['Tide: business bank account for small businesses in the UK and India'];
  const ok = { domain: 'tide.co', evidence_quote: 'business bank account for small businesses', confidence: 'high' };
  assert.equal(checkL1(ok, cands, texts).ok, true);
  assert.equal(checkL1({ ...ok, domain: 'tide-bank.com' }, cands, texts).ok, false, 'not an L0 candidate');
  assert.equal(checkL1({ ...ok, evidence_quote: 'invented sentence about nothing' }, cands, texts).ok, false);
  assert.equal(checkL1({ ...ok, confidence: 'low' }, cands, texts).ok, false);
  assert.equal(checkL1({ domain: null, evidence_quote: '', confidence: 'high' }, cands, texts).none, true);
  assert.equal(checkL1(null, cands, texts).ok, false);
  assert.ok(quoteInEvidence('Business  Bank account', texts) && !quoteInEvidence('short', ['short text']), 'quotes under 8 characters do not count');
});

test('pipeline L5: ATS against the portals board, fingerprint against the profile', () => {
  const found = { ats: 'lever', tenant: 'paytm' };
  assert.equal(compareAts(found, 'https://jobs.lever.co/paytm').state, 'same');
  assert.equal(compareAts(found, 'https://careers.smartrecruiters.com/paytm').state, 'different');
  assert.equal(compareAts(null, 'https://jobs.lever.co/paytm').state, 'no-ats-found');
  assert.equal(compareAts(found, '').state, 'no-board');
  const jobs = Array.from({ length: 12 }, (_, i) => ({ title: `Engineer ${i}`, location: 'Berlin' }));
  const fp = boardFingerprint(jobs, () => false);
  assert.equal(fp.sample.length, 10);
  assert.equal(fingerprintFit(fp, { expectIndia: true }).state, 'mismatch');
  assert.equal(fingerprintFit(fp, { expectIndia: false }).state, 'fits');
  assert.equal(fingerprintFit(boardFingerprint(jobs.slice(0, 3), () => false), { expectIndia: true }).state, 'fits', 'a tiny board is no evidence');
});

test('pipeline L6: accepted only when every gate agrees; a missing verifier queues the row', () => {
  const good = { l1: { ok: true }, l2: { class: 'ok' }, l3: { careersUrl: 'https://x' }, l4: { ok: true }, l5ats: { state: 'same' }, l5fp: { state: 'fits' } };
  assert.equal(gate(good).accepted, true);
  assert.equal(gate({ ...good, l5ats: { state: 'different', detail: 'a vs b' } }).accepted, false);
  assert.equal(gate({ ...good, l4: { ok: false, why: 'not a careers page' } }).accepted, false);
  assert.equal(gate({ ...good, l2: { class: 'ok', parked: true } }).accepted, false);
  assert.equal(gate({ ...good, l2: { class: 'ok', redirectedAway: true, finalHost: 'x.com' } }).accepted, false);
  assert.equal(gate({ ...good, l5fp: { state: 'mismatch', detail: 'none in India' } }).accepted, false);
  assert.equal(gate({ ...good, l4: null }).accepted, false, 'LLM mode needs the verifier');
  assert.equal(gate({ ...good, l4: null }, { needLlm: false }).accepted, true);
  assert.equal(gate({ ...good, l5ats: { state: 'no-board' } }).accepted, true, 'no portals board to compare is not a failure');
  assert.equal(queryVariants('Cred', { expectIndia: true }).length, 4);
  assert.equal(queryVariants('Cred', {})[0], 'Cred careers sde');
});

test('llm: schemas are fixed, prompts carry only the allowed fields, the provider prefix is checked', () => {
  assert.equal(domainSchema.safeParse({ domain: 'a.com', evidence_quote: 'q', confidence: 'high' }).success, true);
  assert.equal(domainSchema.safeParse({ domain: 'a.com' }).success, false);
  assert.equal(verifySchema.safeParse({ is_company_careers_page: true, same_company: 'maybe', ats: 'x', evidence_quote: 'q', confidence: 'high' }).success, false);
  assert.equal(modelName('groq:openai/gpt-oss-120b'), 'openai/gpt-oss-120b');
  assert.equal(modelName('openai/gpt-oss-20b'), 'openai/gpt-oss-20b');
  assert.throws(() => modelName('openai:gpt-4o'));
  const v = verifyPrompt({ profile: { name: 'A', hq: 'India', titles: ['t1'] }, url: 'https://a.com/c', title: 'T', text: 'body', domainChoice: 'SECRET' });
  assert.ok(!v.includes('SECRET') && v.includes('t1'));
  assert.ok(domainPrompt({ company: 'A', candidates: [{ domain: 'a.com', source: 'search', homeText: 'hi', results: [] }] }).includes('a.com [search]'));
});

test('llm: key and model ids come from the environment, then .env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-key-'));
  const saved = { k: process.env.GROQ_API_KEY, m: process.env.GROQ_MODEL };
  try {
    delete process.env.GROQ_API_KEY; delete process.env.GROQ_MODEL;
    assert.equal(loadGroqKey([dir]), '');
    writeFileSync(join(dir, '.env'), 'OTHER=1\nGROQ_API_KEY="gsk_test"\nGROQ_MODEL=groq:custom-model\n');
    assert.equal(loadGroqKey([dir]), 'gsk_test');
    assert.equal(loadModels([dir]).model, 'groq:custom-model');
    assert.equal(loadModels([dir]).fallback, 'groq:openai/gpt-oss-20b');
    process.env.GROQ_API_KEY = 'from-env';
    assert.equal(loadGroqKey([dir]), 'from-env');
  } finally { for (const [k, n] of [['k', 'GROQ_API_KEY'], ['m', 'GROQ_MODEL']]) { if (saved[k] === undefined) delete process.env[n]; else process.env[n] = saved[k]; } rmSync(dir, { recursive: true, force: true }); }
});

test('golden: unconfirmed expectations must be queued; confirmed ones are checked as allowed sets', () => {
  const cases = readGolden(new URL('./discover-golden.tsv', import.meta.url).pathname);
  assert.ok(cases.length >= 12 && ['TIDE', 'Zepto', 'TCS', 'Wipro', 'Slice', 'Apna', 'Cred', 'Sagent', 'Groww', 'Paytm', 'Glance', 'Unacademy'].every((n) => cases.some((c) => c.company === n)));
  assert.ok(cases.every((c) => c.expect === 'unknown' && c.domains.length === 0), 'nothing is confirmed until the user supplies it');
  const queued = cases.map((c) => ({ company: c.company, status: 'queued', domain: '', ats: '', reason: 'x' }));
  assert.deepEqual(checkGolden(cases, queued), []);
  const accepted = queued.map((r) => (r.company === 'Zepto' ? { ...r, status: 'accepted', domain: 'zeptonow.com' } : r));
  assert.ok(checkGolden(cases, accepted).some((f) => /Zepto.*must be queued/.test(f)), 'even a correct-looking accept fails while the expectation is unconfirmed');
  const confirmed = [{ company: 'Cred', domains: ['cred.club'], expect: 'any', ats: '' }];
  assert.ok(checkGolden(confirmed, [{ company: 'Cred', status: 'accepted', domain: 'cred.co.in', ats: '' }]).some((f) => /WRONG domain/.test(f)));
  assert.deepEqual(checkGolden(confirmed, [{ company: 'Cred', status: 'accepted', domain: 'www.cred.club', ats: '' }]), []);
  assert.ok(checkGolden([{ company: 'X', domains: [], expect: 'accept', ats: '' }], [{ company: 'X', status: 'accepted', domain: 'x.com' }]).some((f) => /no confirmed domain/.test(f)));
});

test('gate: a row decided only by the fallback model at both LLM layers is queued', () => {
  const good = { l1: { ok: true }, l2: { class: 'ok' }, l3: { careersUrl: 'https://x' }, l4: { ok: true } };
  assert.equal(gate({ ...good, fb: { l1: true, l4: false } }).accepted, true);
  assert.equal(gate({ ...good, fb: { l1: false, l4: true } }).accepted, false, 'verifier on the fallback model always queues');
  const both = gate({ ...good, fb: { l1: true, l4: true } });
  assert.equal(both.accepted, false);
  assert.match(both.failed[0], /primary_model/);
});

test('classify: a custom careers page on a domain we only guessed goes to review', () => {
  assert.equal(classify({ domain: 'cred.co.in', domainVerified: true, domainSource: 'guess', ats: null, careersUrl: 'https://cred.co.in/', pagesLoaded: 2 }).confidence, 'needs-review');
  assert.equal(classify({ domain: 'a.com', domainVerified: true, domainSource: 'override', ats: null, careersUrl: 'https://a.com/careers', pagesLoaded: 2 }).confidence, 'medium');
});

test('golden: an all-unknown file never counts as a pass, and fewer than 10 confirmed cases never counts either', () => {
  const unknown = Array.from({ length: 18 }, (_, i) => ({ company: `C${i}`, domains: [], expect: 'unknown', ats: '' }));
  const v = goldenVerdict(unknown, []);
  assert.equal(v.passed, false);
  assert.equal(v.confirmed, 0);
  const nine = Array.from({ length: 9 }, (_, i) => ({ company: `K${i}`, domains: ['k.com'], expect: 'accept', ats: '' }));
  assert.equal(goldenVerdict(nine, []).passed, false);
  const ten = [...nine, { company: 'K9', domains: ['k.com'], expect: 'accept', ats: '' }];
  assert.equal(goldenVerdict(ten, []).passed, true);
  assert.equal(goldenVerdict(ten, ['K1: accepted WRONG domain']).passed, false, 'any failure blocks the marker');
});

test('golden: known-wrong domains fail once the confirmed set is filled in', () => {
  const cases = [
    { company: 'Zepto', domains: ['zeptonow.com'], expect: 'accept', ats: '' },
    { company: 'Cred', domains: ['cred.club'], expect: 'accept', ats: '' },
    { company: 'TIDE', domains: ['tide.co'], expect: 'accept', ats: '' },
  ];
  const rows = [
    { company: 'Zepto', status: 'accepted', domain: 'planet1.co' },
    { company: 'Cred', status: 'accepted', domain: 'cred.co.in' },
    { company: 'TIDE', status: 'accepted', domain: 'tide.com' },
  ];
  const fails = checkGolden(cases, rows);
  assert.equal(fails.filter((f) => /WRONG domain/.test(f)).length, 3);
});

test('tsv writer: header and row have the same column count, with validation and model present', () => {
  assert.ok(COLUMNS.includes('validation') && COLUMNS.includes('model'));
  const row = tsvRow({ company: 'A\tB', domain: 'a.com', model: 'L1:x;L4:y', validation: 'unvalidated', reason: 'line\nbreak' });
  assert.equal(row.split('\t').length, COLUMNS.length);
  assert.equal(row.split('\t')[COLUMNS.indexOf('validation')], 'unvalidated');
  assert.equal(row.split('\t')[COLUMNS.indexOf('model')], 'L1:x;L4:y');
});

test('redact: API keys and Authorization headers never reach a log or a TSV row', () => {
  const key = 'gsk_abcdEFGH1234567890abcd';
  for (const t of [`GROQ_API_KEY=${key}`, `Authorization: Bearer ${key}`, `{"authorization":"Bearer ${key}"}`, `apiKey: ${key}`, `failed with ${key} in it`]) {
    assert.ok(!redact(t).includes('abcdEFGH'), `leaked: ${redact(t)}`);
  }
  const row = tsvRow({ company: 'A', reason: `error: Authorization: Bearer ${key}`, evidence: `key ${key}` });
  assert.ok(!row.includes('abcdEFGH'));
  assert.equal(redact('plain text stays'), 'plain text stays');
});

test('aggregator boards: the identity gate skips a listed host and nothing in the pipeline writes the list', async () => {
  const hosts = parseAggregatorHosts('# c\njobs.3one4capital.com\tnote\nhttps://x.example/path\n');
  assert.ok(isAggregatorBoard('https://jobs.3one4capital.com/jobs', hosts));
  assert.ok(isAggregatorBoard('https://x.example/anything', hosts));
  assert.ok(!isAggregatorBoard('https://jobs.lever.co/acme', hosts));
  const res = await auditBoard({ entry: { name: '3one4 Capital', careers_url: 'https://jobs.3one4capital.com/jobs' }, jobs: [{ url: 'https://other.com/1' }], strict: true, approved: new Set(), fetchOwner: async () => { throw new Error('no'); }, site: async () => ({ ok: false }), aggregators: hosts });
  assert.equal(res.how, 'aggregator');
  assert.deepEqual(res.reasons, []);
  const flagged = await auditBoard({ entry: { name: '3one4 Capital', careers_url: 'https://jobs.3one4capital.com/jobs' }, jobs: [], strict: true, approved: new Set(), fetchOwner: async () => '', site: async () => ({ ok: false }) });
  assert.ok(flagged.reasons.length, 'without the list the same board is flagged');
  const root = new URL('..', import.meta.url).pathname;
  for (const dir of ['lib', 'tools']) for (const f of readdirSync(join(root, dir)).filter((x) => x.endsWith('.mjs'))) {
    const src = readFileSync(join(root, dir, f), 'utf8');
    if (!src.includes('aggregator-boards')) continue;
    assert.ok(!/(writeFileSync|appendFileSync|writeFile|renameSync)\([^)]*aggregator/i.test(src), `${f} must not write aggregator-boards.tsv`);
  }
});

test('bing result links are unwrapped to the real URL', () => {
  const real = 'https://www.tcs.com/careers';
  const wrapped = `https://www.bing.com/ck/a?!&&p=abc&u=a1${Buffer.from(real).toString('base64url')}&ntb=1`;
  assert.equal(unwrapBingUrl(wrapped), real);
  assert.equal(unwrapBingUrl('https://example.com/x'), 'https://example.com/x');
});

test('query pairs: pass 1 merges the sde and official-website forms, the retry merges the other two', () => {
  assert.deepEqual(queryPair('Zepto', {}, 0), ['Zepto careers sde', 'Zepto official website']);
  assert.deepEqual(queryPair('Zepto', {}, 1), ['Zepto careers', 'Zepto jobs']);
});
