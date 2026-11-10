import { test } from 'node:test';
import assert from 'node:assert/strict';
import p, { parseSitemap, judgeSlug, extractJobPosting, toJob, resolveOptions } from '../../providers/cutshort.mjs';

const NOW = Date.parse('2026-11-10T00:00:00Z');
const iso = (daysAgo) => new Date(NOW - daysAgo * 864e5).toISOString();
const u = (slug) => `https://cutshort.io/job/${slug}`;
const sitemap = (rows) => `<?xml version="1.0"?><urlset>${rows.map(([l, m]) => `<url> <loc>${l}</loc> <lastmod>${m}</lastmod> </url>`).join('')}</urlset>`;
const page = (o = {}) => `<html><script type="application/ld+json">{"@type":"WebPage"}</script><script type="application/ld+json">${JSON.stringify({
  '@type': 'JobPosting', title: 'Python Developer', datePosted: iso(1), description: '<p>Build <b>APIs</b></p>',
  experienceRequirements: { monthsOfExperience: 6 }, hiringOrganization: { name: 'Acme' },
  jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'IN' } },
  baseSalary: { currency: 'INR', value: { minValue: 300000, maxValue: 600000 } }, ...o })}</script></html>`;
const opts = resolveOptions({});

test('sitemap parses job urls and dates, rejects foreign urls, throws on a changed format', () => {
  const rows = parseSitemap(sitemap([[u('Python-Developer-Pune-Acme-abc123'), '2026-11-09T10:00:00Z'], ['https://evil.example/job/x', '2026-11-09T10:00:00Z']]));
  assert.equal(rows.length, 1); assert.equal(rows[0].lastmod, Date.parse('2026-11-09T10:00:00Z'));
  assert.throws(() => parseSitemap('<html>blocked</html>'), /not a urlset/);
  assert.throws(() => parseSitemap(sitemap([])), /no job URLs/);
});
test('slug judge keeps tech roles and drops senior and non-tech', () => {
  assert.deepEqual(judgeSlug(u('Python-Developer-Pune-Acme-abc123')), { keep: true });
  assert.equal(judgeSlug(u('Senior-Python-Developer-Pune-Acme-abc123')).keep, false);
  assert.equal(judgeSlug(u('Sales-Executive-Pune-Acme-abc123')).keep, false);
  assert.deepEqual(judgeSlug(u('Software-Engineer-Intern-Pune-Acme-abc123')), { keep: true });
  assert.equal(judgeSlug(u('Welder-Pune-Acme-abc123'), { include: ['welder'] }).keep, true);
});
test('JobPosting is found among other ld+json blocks; bad json is skipped', () => {
  assert.equal(extractJobPosting(page()).title, 'Python Developer');
  assert.equal(extractJobPosting('<script type="application/ld+json">{oops</script>'), null);
});
test('toJob keeps a fresh fresher job and rejects old, experienced and foreign ones', () => {
  const r = toJob(u('x-abc123'), JSON.parse(/>({"@type":"JobPosting".*?})<\/script><\/html>/.exec(page())[1]), opts, NOW);
  assert.equal(r.job.company, 'Acme'); assert.equal(r.job.location, 'Pune'); assert.equal(r.job.externalId, 'abc123');
  assert.equal(r.job.postedAt, NOW - 864e5); assert.deepEqual(r.job.salary, { min: 300000, max: 600000, currency: 'INR' });
  assert.match(r.job.description, /^Experience: 6 months\. Build APIs/);
  assert.equal(toJob(u('x-a'), { title: 'T', datePosted: iso(30) }, opts, NOW).reject, 'old');
  assert.equal(toJob(u('x-a'), { title: 'T', datePosted: iso(1), experienceRequirements: { monthsOfExperience: 36 } }, opts, NOW).reject, 'experienced');
  assert.equal(toJob(u('x-a'), { title: 'T', jobLocation: { address: { addressCountry: 'US' } } }, opts, NOW).reject, 'abroad');
  assert.ok(toJob(u('x-a'), { title: 'T' }, opts, NOW).job, 'no date and no experience figure is kept');
});
test('options are clamped', () => {
  assert.deepEqual(resolveOptions({}), { sinceDays: 14, maxExperienceMonths: 12, maxFetch: 300, include: [], exclude: [] });
  assert.equal(resolveOptions({ maxFetch: 99999 }).maxFetch, 300);
  assert.equal(resolveOptions({ maxExperienceMonths: 0 }).maxExperienceMonths, 0);
  assert.equal(p.detect({}), null);
});
test('fetch reads newest first, stops after a run of old pages, and caches experience rejects', async () => {
  const now = Date.now(); const stamp = (d) => new Date(now - d * 864e5).toISOString();
  const L = (n) => u(`Python-Developer-Pune-Acme-id${n}`);
  const posted = [1, 2, 3, 20, 25, 30, 40]; // newest first, like the sitemap
  const pages = Object.fromEntries(posted.map((d, i) => [L(i), page({ datePosted: stamp(d), experienceRequirements: { monthsOfExperience: i === 1 ? 48 : 0 } })]));
  const asked = []; const cache = new Map();
  const ctx = {
    sleep: async () => {}, idCache: { get: (k) => cache.get(k), set: (k, v) => cache.set(k, v), delete: (k) => cache.delete(k) },
    fetchText: async (url) => { if (url.endsWith('.xml')) return sitemap([...posted.keys(), 'x'].map((i) => [i === 'x' ? u('Senior-Java-Developer-Pune-Acme-zzz') : L(i), stamp(0.5)])); asked.push(url); return pages[url]; },
  };
  const jobs = await p.fetch({}, ctx);
  assert.deepEqual(jobs.map((j) => j.externalId), ['id0', 'id2']); // id1 asks for 4 years
  assert.equal(asked.length, 6, 'stops after 3 old pages in a row, never reads id6');
  assert.equal(cache.get(`cutshort:${L(1)}`).id, 'experienced'); assert.equal(cache.has(`cutshort:${L(3)}`), false, 'old pages are not cached');
  asked.length = 0; await p.fetch({}, ctx);
  assert.ok(!asked.includes(L(1)), 'a cached reject is not fetched again');
});
test('fetch fails loudly when every page fails, but not when the sitemap lists nothing recent', async () => {
  const stamp = new Date().toISOString();
  const bad = { sleep: async () => {}, fetchText: async (url) => { if (url.endsWith('.xml')) return sitemap([[u('Python-Developer-Pune-Acme-bbb222'), stamp]]); throw new Error('HTTP 403'); } };
  const empty = { sleep: async () => {}, fetchText: async () => sitemap([[u('Python-Developer-Pune-Acme-bbb222'), '2020-01-01T00:00:00Z']]) };
  assert.deepEqual(await p.fetch({}, empty), []);
  const five = Array.from({ length: 6 }, (_, i) => [u(`Python-Developer-Pune-Acme-id${i}`), stamp]);
  await assert.rejects(p.fetch({}, { ...bad, fetchText: async (url) => { if (url.endsWith('.xml')) return sitemap(five); throw new Error('HTTP 403'); } }), /403/);
});
