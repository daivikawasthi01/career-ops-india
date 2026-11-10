#!/usr/bin/env node
/**
 * import-careers-directory.mjs: pull the public "official careers pages" list from careersat.tech (India-focused,
 * ~1,700 companies, each linking to the employer's own careers page) and turn it into three things:
 *
 *   data/careers-directory.tsv              company, careers_url, ats (guessed from the URL host), in_portals, in_companies
 *   data/careers-directory-new-companies.txt  company names not yet in companies.txt (feed for discover-careers.mjs --companies)
 *   data/careers-directory-hosts.txt        Keka/Darwinbox/Zoho/Eightfold tenant hosts found (feed for probe-india-ats.mjs --hosts)
 *
 * It also reports which ATS the list points at, so you can see which ATS matter for Indian fresher hiring.
 * Reads one public page like a visitor (robots.txt only closes /_next/). Never edits companies.txt or portals.yml.
 *
 *   node tools/import-careers-directory.mjs             fetch live
 *   node tools/import-careers-directory.mjs --file x.html  parse a saved copy
 */
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const JOBAPPLY = resolve(HERE, '..', '..');
const ROOT = process.env.CAREER_OPS_ROOT || join(JOBAPPLY, 'career-ops');
const DATA = join(ROOT, 'data');
const SOURCE = 'https://careersat.tech/career-pages';

const ATS_HOSTS = [
  ['greenhouse', /(^|\.)greenhouse\.io$/], ['lever', /(^|\.)lever\.co$/], ['ashby', /(^|\.)ashbyhq\.com$/],
  ['workday', /myworkdayjobs\.com$/], ['smartrecruiters', /smartrecruiters\.com$/], ['workable', /(^|\.)workable\.com$/],
  ['keka', /\.keka\.com$/], ['darwinbox', /\.darwinbox\.(in|com)$/], ['zoho-recruit', /\.zohorecruit\./], ['zoho-careers', /careers\.zohocorp\.com$/],
  ['eightfold', /\.eightfold\.ai$/], ['freshteam', /\.freshteam\.com$/], ['successfactors', /successfactors\.(com|eu)$/],
  ['oracle', /oraclecloud\.com$/], ['icims', /icims\.com$/], ['bamboohr', /bamboohr\.com$/], ['recruitee', /recruitee\.com$/],
  ['breezy', /breezy\.hr$/], ['dayforce', /dayforcehcm\.com$/], ['careers-page', /careers-page\.com$/], ['peoplestrong', /peoplestrong\.com$/],
  ['skillate', /skillate\.com$/], ['zimyo', /zimyo\.(com|work)$/], ['springrecruit', /springrecruit\.com$/],
];

export const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** (company, url) pairs from the directory page: every external link whose text is a plain company name. */
export function parseDirectory(html) {
  const out = new Map();
  const re = /<a\s[^>]*href="(https?:\/\/[^"]+)"[^>]*>([^<]{2,80})<\/a>/gi;
  for (let m; (m = re.exec(html)); ) {
    let url; try { url = new URL(decode(m[1])); } catch { continue; }
    if (/careersat\.tech$/.test(url.hostname)) continue;
    const name = decode(m[2]).replace(/\s+/g, ' ').trim();
    if (!name || /^(read more|view|apply|visit|careers?|jobs?)$/i.test(name)) continue;
    const key = name.toLowerCase();
    if (!out.has(key)) out.set(key, { company: name, url: url.href });
  }
  return [...out.values()];
}

export function atsOf(url) {
  let h; try { h = new URL(url).hostname.toLowerCase(); } catch { return 'unknown'; }
  for (const [name, re] of ATS_HOSTS) if (re.test(h)) return name;
  return 'custom';
}

const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n') : []);

async function main() {
  const argv = process.argv.slice(2);
  const fileArg = argv.indexOf('--file') >= 0 ? argv[argv.indexOf('--file') + 1] : null;
  let html;
  if (fileArg) html = readFileSync(fileArg, 'utf8');
  else {
    const r = await fetch(SOURCE, { signal: AbortSignal.timeout(60000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; career-ops directory-import)' } });
    if (!r.ok) throw new Error(`${SOURCE} answered HTTP ${r.status}`);
    html = await r.text();
  }
  const rows = parseDirectory(html);
  if (rows.length < 200) throw new Error(`only ${rows.length} entries parsed: the page layout probably changed, nothing written`);

  const known = new Set(lines(join(JOBAPPLY, 'companies.txt')).filter((l) => l.trim() && !l.startsWith('#')).map((l) => norm(l.split(',')[0].replace(/^["']|["']$/g, ''))));
  for (const l of lines(join(DATA, 'careers-discovery.tsv')).slice(1)) known.add(norm(l.split('\t')[0]));
  const portals = lines(join(ROOT, 'portals.yml')).filter((l) => !/^\s*#/.test(l)).join('\n').toLowerCase();

  const tsv = ['company\tcareers_url\tats\tin_portals\tin_companies'];
  const fresh = [], hosts = new Set(); const byAts = {};
  for (const r of rows) {
    const ats = atsOf(r.url); byAts[ats] = (byAts[ats] || 0) + 1;
    const host = new URL(r.url).hostname.toLowerCase();
    const inPortals = portals.includes(host) && (ats !== 'custom') ? 'yes' : portals.includes(r.url.toLowerCase().replace(/\/$/, '')) ? 'yes' : 'no';
    const inCompanies = known.has(norm(r.company)) ? 'yes' : 'no';
    tsv.push([r.company, r.url, ats, inPortals, inCompanies].map((v) => String(v).replace(/[\t\r\n]+/g, ' ')).join('\t'));
    if (inCompanies === 'no') fresh.push(r.company);
    if (['keka', 'darwinbox', 'zoho-recruit', 'eightfold'].includes(ats)) hosts.add(`${host}\t${r.company}`);
  }
  writeFileSync(join(DATA, 'careers-directory.tsv'), tsv.join('\n') + '\n');
  writeFileSync(join(DATA, 'careers-directory-new-companies.txt'), fresh.join('\n') + '\n');
  writeFileSync(join(DATA, 'careers-directory-hosts.txt'), [...hosts].join('\n') + '\n');
  console.log(`${rows.length} companies, ${fresh.length} not in companies.txt or the discovery run, ${hosts.size} Indian-ATS tenant hosts`);
  console.log('ATS mix:', Object.entries(byAts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' '));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exit(1); });
