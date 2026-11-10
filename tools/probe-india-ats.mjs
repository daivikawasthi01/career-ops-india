#!/usr/bin/env node
/**
 * probe-india-ats.mjs: find which companies run their careers site on an Indian-market ATS
 * (Keka, Darwinbox, Zoho Recruit, Eightfold) by probing tenant hostnames guessed from company names and domains.
 *
 * Why probing: certificate transparency lists none of these tenants (they sit under wildcard certs), and
 * Common Crawl's index is too flaky to depend on. A tenant host is cheap to test, though: each provider
 * answers a missing tenant in one request with a clear signal (Keka 302 to TenantNotFound, Darwinbox HTTP 500,
 * Zoho "no id=jobs input", Eightfold 404), so a miss is a definite miss and a hit comes back with its postings.
 *
 * Output (all append-only, resumable; never touches portals.yml):
 *   data/india-ats-probe.tsv    one line per (company, vendor, slug) already tested and its verdict
 *   data/india-ats-boards.tsv   one line per live board: company, vendor, url, jobs, india_jobs, confidence, sample
 *   data/india-ats-boards.yml   portals.yml entries for the live boards (confidence high by default), to review
 *
 * Run:  node tools/probe-india-ats.mjs                       probe every name in companies.txt + careers-discovery.tsv
 *       node tools/probe-india-ats.mjs --limit 200           first 200 names only
 *       node tools/probe-india-ats.mjs --hosts hosts.txt     also test explicit tenant hosts (one per line)
 *       node tools/probe-india-ats.mjs --vendors keka,darwinbox
 *       node tools/probe-india-ats.mjs --emit-only           rebuild the .yml from the boards file
 *       node tools/probe-india-ats.mjs --min-confidence low  put low-confidence boards in the .yml too
 * Transient errors (timeouts, 429, 5xx other than the known miss signal) are not recorded, so the next run retries them.
 */
import { readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { makeHttpCtx } from '../providers/_http.mjs';
import keka from '../providers/keka.mjs';
import darwinbox from '../providers/darwinbox.mjs';
import zoho from '../providers/zoho-recruit.mjs';
import eightfold from '../providers/eightfold.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const JOBAPPLY = resolve(HERE, '..', '..');
const ROOT = process.env.CAREER_OPS_ROOT || join(JOBAPPLY, 'career-ops');
const DATA = join(ROOT, 'data');

export const INDIA_RE = /\b(india|bengaluru|bangalore|mumbai|delhi|ncr|gurugram|gurgaon|noida|hyderabad|chennai|pune|kolkata|ahmedabad|kochi|cochin|jaipur|indore|chandigarh|coimbatore|thiruvananthapuram|trivandrum|nagpur|bhubaneswar|lucknow|vadodara|mysuru|mysore|mangaluru)\b/i;
const LEGAL = /\b(private|pvt|limited|ltd|llp|inc|incorporated|corp|corporation|co|company|technologies|technology|tech|solutions|services|software|systems|labs|india|global|group|holdings|ventures|networks|digital|consulting|enterprises)\b\.?/gi;

// ---------- slugs ----------
const clean = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const validLabel = (s) => /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/.test(s) && s.length >= 3;

/** Candidate tenant labels for a company, each with a confidence: high when the label is the whole name or the website's own label. */
export function slugCandidates(name, domain = '') {
  const out = new Map(); // slug -> confidence
  const add = (slug, conf) => { if (validLabel(slug) && !out.has(slug)) out.set(slug, conf); };
  const n = clean(name).replace(/&/g, ' and ').replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  const stripped = n.replace(LEGAL, ' ').replace(/\s+/g, ' ').trim();
  const d = clean(domain).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  const parts = d.split('.');
  if (parts.length >= 2) { // registrable label: acme.co.in -> acme, acme.com -> acme
    const sld = ['co', 'com', 'org', 'net', 'ac'].includes(parts[parts.length - 2]) && parts.length >= 3 ? parts[parts.length - 3] : parts[parts.length - 2];
    add(sld, 'high');
  }
  const variants = (base) => { if (!base) return; add(base.replace(/[\s-]+/g, ''), 'high'); add(base.replace(/\s+/g, '-'), 'high'); };
  variants(stripped || n);
  const first = (stripped || n).split(' ')[0];
  if ((stripped || n).includes(' ')) add(first, 'low');
  if (stripped && stripped !== n) variants(n); // the full legal name, last: it rarely is the tenant
  return [...out].slice(0, 4).map(([slug, confidence]) => ({ slug, confidence }));
}

// ---------- vendors ----------
const VENDORS = {
  keka: { provider: keka, url: (s) => [`https://${s}.keka.com/careers`], spacingMs: 120 },
  darwinbox: { provider: darwinbox, url: (s) => [`https://${s}.darwinbox.in/ms/candidatev2/main/careers/allJobs`], spacingMs: 150 },
  zoho: { provider: zoho, url: (s) => [`https://${s}.zohorecruit.in/jobs/Careers`, `https://${s}.zohorecruit.com/jobs/Careers`], spacingMs: 200 },
  eightfold: { provider: eightfold, url: (s) => [`https://${s}.eightfold.ai/careers`], spacingMs: 200 },
};

const causeCode = (err) => err?.cause?.code || err?.code || (/ENOTFOUND/.test(String(err?.cause?.message || '')) ? 'ENOTFOUND' : '');

/** Is this provider error the vendor's definite "no such tenant"? Anything else is transient and gets retried on a later run. */
export function isMiss(vendor, err) {
  const m = String(err?.message || err);
  const status = Number(err?.status) || Number((/HTTP (\d{3})/.exec(m) || [])[1]) || 0;
  if (vendor === 'keka') return /no such tenant|TenantNotFound/i.test(m) || status === 404;
  if (vendor === 'darwinbox') return status === 500 || status === 404 || /unexpected response/i.test(m);
  if (vendor === 'zoho') return /no id="jobs" input|unknown tenant/i.test(m) || status === 404;
  if (vendor === 'eightfold') return status === 404 || status === 400 || status === 422 || causeCode(err) === 'ENOTFOUND' || /not found|unknown/i.test(m);
  return false;
}

async function probeOne(vendor, url, name, ctx) {
  const entry = { name, careers_url: url };
  try {
    const jobs = await VENDORS[vendor].provider.fetch(entry, ctx);
    return { state: 'hit', jobs };
  } catch (err) {
    return isMiss(vendor, err) ? { state: 'miss' } : { state: 'transient', error: String(err?.message || err).slice(0, 120) };
  }
}

// ---------- io ----------
function readLines(f) { return f && existsSync(f) ? readFileSync(f, 'utf8').split('\n') : []; }
const tsvSafe = (s) => String(s ?? '').replace(/[\t\r\n]+/g, ' ').trim();

export function readNames({ companiesFile, discoveryFile, extra }) {
  const byName = new Map(); // normalized name -> {name, domain}
  const put = (name, domain = '') => {
    name = String(name || '').trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!name || name.startsWith('#')) return;
    const m = /^(.+?),[a-z][a-z_ ]*,\d*,[A-Za-z][A-Za-z ]*,\S.*$/.exec(name); // companies.txt lines carrying CSV junk
    if (m) name = m[1].trim();
    const k = clean(name).replace(/[^a-z0-9]/g, '');
    if (!k) return;
    const cur = byName.get(k);
    if (!cur) byName.set(k, { name, domain });
    else if (!cur.domain && domain) cur.domain = domain;
  };
  for (const l of readLines(companiesFile)) put(l);
  for (const l of readLines(discoveryFile).slice(1)) { const c = l.split('\t'); put(c[0], c[1]); }
  for (const l of extra || []) put(l);
  return [...byName.values()];
}

function existingHosts(portalsFile) {
  const hosts = new Set();
  if (!existsSync(portalsFile)) return hosts;
  for (const l of readFileSync(portalsFile, 'utf8').split('\n')) {
    if (/^\s*#/.test(l)) continue;
    const m = /https:\/\/([a-z0-9-]+\.(?:keka\.com|darwinbox\.in|zohorecruit\.[a-z.]+|eightfold\.ai))/i.exec(l);
    if (m) hosts.add(m[1].toLowerCase());
  }
  return hosts;
}

export function boardsToYaml(boardRows, minConfidence = 'high') {
  const rank = { low: 0, high: 1 };
  const out = ['# Generated by tools/probe-india-ats.mjs. Review, then paste under tracked_companies in portals.yml.', ''];
  for (const b of boardRows) {
    if ((rank[b.confidence] ?? 0) < rank[minConfidence]) continue;
    if (!Number(b.jobs)) continue; // an empty board adds nothing to scan yet; it stays in the tsv for a later pass
    out.push(`- name: ${JSON.stringify(b.company)}`, `  careers_url: ${b.url}`, `  notes: ${JSON.stringify(`${b.vendor} board, ${b.jobs} jobs (${b.india} India). ${b.sample}`)}`, '  enabled: true', '');
  }
  return out.join('\n');
}

function readBoards(file) {
  return readLines(file).slice(1).filter(Boolean).map((l) => {
    const [company, vendor, url, jobs, india, confidence, sample] = l.split('\t');
    return { company, vendor, url, jobs, india, confidence, sample };
  });
}

// ---------- main ----------
async function main() {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const flag = (k) => argv.includes(k);
  const vendors = (opt('--vendors', Object.keys(VENDORS).join(',')) || '').split(',').filter((v) => VENDORS[v]);
  const limit = Number(opt('--limit', 0)) || Infinity;
  const workers = Number(opt('--workers', 6));
  const minConf = opt('--min-confidence', 'high');
  mkdirSync(DATA, { recursive: true });
  const probeFile = join(DATA, 'india-ats-probe.tsv');
  const boardsFile = join(DATA, 'india-ats-boards.tsv');
  const yamlFile = join(DATA, 'india-ats-boards.yml');
  if (!existsSync(boardsFile)) writeFileSync(boardsFile, 'company\tvendor\turl\tjobs\tindia_jobs\tconfidence\tsample\n');
  if (flag('--emit-only')) { writeFileSync(yamlFile, boardsToYaml(readBoards(boardsFile), minConf)); console.log(`wrote ${yamlFile}`); return; }

  const extra = readLines(opt('--hosts'));
  const names = readNames({ companiesFile: join(JOBAPPLY, 'companies.txt'), discoveryFile: join(DATA, 'careers-discovery.tsv'), extra: ['telegram-companies.txt', 'funding-companies.txt', 'careers-directory-new-companies.txt'].flatMap((f) => readLines(join(DATA, f))) }).slice(0, flag('--hosts-only') ? 0 : limit);
  const known = existingHosts(join(ROOT, 'portals.yml'));
  const done = new Set(readLines(probeFile).map((l) => l.split('\t').slice(0, 3).join('\t')));

  const items = [];
  for (const { name, domain } of names) for (const { slug, confidence } of slugCandidates(name, domain)) for (const v of vendors) items.push({ name, vendor: v, slug, confidence });
  for (const h of extra) { // explicit hosts, one per line: "<slug>.keka.com" or "<slug>.keka.com<TAB>Company Name" (a name given by a directory = high confidence)
    const [hostPart, namePart] = h.split('\t');
    const m = /^\s*([a-z0-9-]+)\.(keka\.com|darwinbox\.in|zohorecruit\.[a-z.]+|eightfold\.ai)\s*$/i.exec(hostPart);
    if (m) items.push({ name: (namePart || '').trim() || m[1], vendor: m[2].startsWith('keka') ? 'keka' : m[2].startsWith('darwin') ? 'darwinbox' : m[2].startsWith('zoho') ? 'zoho' : 'eightfold', slug: m[1].toLowerCase(), confidence: namePart ? 'high' : 'low' });
  }
  const todo = items.filter((it) => !done.has(`${it.name}\t${it.vendor}\t${it.slug}`));
  console.log(`probe: ${names.length} names, ${items.length} probes, ${todo.length} still to do, vendors ${vendors.join(',')}`);

  const ctx = makeHttpCtx(); ctx.maxPages = 1;
  const nextSlot = {}; let i = 0, hits = 0, transient = 0, n = 0;
  const gate = async (vendor) => { // spaces calls to one vendor, shared across workers
    const now = Date.now(); const at = Math.max(now, nextSlot[vendor] || 0);
    nextSlot[vendor] = at + VENDORS[vendor].spacingMs;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  };
  const seenBoard = new Set(readBoards(boardsFile).map((b) => b.url));

  const deadline = Date.now() + (Number(opt('--max-minutes', 0)) || 1e9) * 60000;
  async function worker() {
    for (; Date.now() < deadline; ) {
      const it = todo[i++]; if (!it) return;
      let verdict = 'miss', hit = null;
      for (const url of VENDORS[it.vendor].url(it.slug)) {
        if (known.has(new URL(url).hostname)) { verdict = 'already-tracked'; break; }
        await gate(it.vendor);
        const r = await probeOne(it.vendor, url, it.name, ctx);
        if (r.state === 'hit') { verdict = 'hit'; hit = { url, jobs: r.jobs }; break; }
        if (r.state === 'transient') verdict = 'transient';
      }
      n++;
      if (verdict === 'transient') { transient++; continue; } // not recorded: retried next run
      appendFileSync(probeFile, `${it.name}\t${it.vendor}\t${it.slug}\t${verdict}\n`);
      if (hit && !seenBoard.has(hit.url)) {
        seenBoard.add(hit.url); hits++;
        const india = hit.jobs.filter((j) => INDIA_RE.test(j.location || '')).length;
        const sample = hit.jobs.slice(0, 3).map((j) => j.title).join(' | ');
        appendFileSync(boardsFile, [it.name, it.vendor, hit.url, hit.jobs.length, india, it.confidence, sample].map(tsvSafe).join('\t') + '\n');
        console.log(`  HIT ${it.vendor} ${hit.url} jobs=${hit.jobs.length} india=${india} conf=${it.confidence}`);
      }
      if (n % 200 === 0) console.log(`  ${n}/${todo.length} probed, ${hits} boards, ${transient} transient`);
    }
  }
  await Promise.all(Array.from({ length: workers }, worker));
  writeFileSync(yamlFile, boardsToYaml(readBoards(boardsFile), minConf));
  console.log(`done: ${hits} new boards, ${transient} transient (re-run to retry). Review ${yamlFile}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });
