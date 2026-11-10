#!/usr/bin/env node
/**
 * telegram-companies.mjs: harvest EMPLOYER NAMES (not job links) from public Indian fresher-hiring Telegram channels.
 * The channels post "<Company> Hiring 2026 - <Role>" with a link shortener as the apply link, which the repo's
 * telegram-channel provider rightly refuses (no employer URL). The company name is still a real lead, so it goes to
 * data/telegram-companies.txt (one per line, new names only) for discover-careers.mjs --companies to resolve to the
 * employer's own careers page. Reads t.me/s/<channel> like a visitor: no login, no account, a few pages per channel.
 *
 *   node tools/telegram-companies.mjs                      default channels, 5 pages each
 *   node tools/telegram-companies.mjs --channels a,b --pages 8
 */
import { readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const JOBAPPLY = resolve(HERE, '..', '..');
const DATA = join(process.env.CAREER_OPS_ROOT || join(JOBAPPLY, 'career-ops'), 'data');
// Tested 2026-11-10: these return posts and were active that week. Dropped: offcampusjobindia (last post 2022), offcampusjobs2024 (2025), freshercareersdotin (Jan 2026),
// freshers_opening / OffCampusJobsIndia / takeUforward / striver_jobs / carrer_bytes / fresherscafe / jobs_opportunities_hub / naukrijunction (no web preview). zunobyfoundit posts forms, not employers.
export const DEFAULT_CHANNELS = ['PlacementDriveOfficial', 'freshershunt', 'fresherjobinfo', 'freshersdunia', 'freshersjobs24', 'OffCampusJobs4u', 'FresherOffCampus'];

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#33;/g, '!').replace(/&#036;/g, '$').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

const JUNK = /^(new|urgent|latest|big|mega|top|hot|job|jobs|multiple|various|walk[- ]?in|off[- ]?campus|freshers?|apply|today|daily|internship|hiring)$/i;
const cleanName = (n) => n.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}).]+$/gu, '').replace(/\s+/g, ' ').trim();
const okName = (n) => n.length >= 2 && n.length <= 60 && !JUNK.test(n) && !/^\d+$/.test(n) && !/https?:/.test(n);

const NOISE_TAIL = /\s+(mass|bulk|work from home( jobs)?|wfh|hiring|jobs?|recruitment|drive|off[- ]?campus|freshers?)\s*$/i;
const ONE_COMPANY = /^(procter & gamble|johnson & johnson|marks & spencer|ernst & young|at&t|l&t|p&g|h&m|ey|b&q|d&b)$/i;

/**
 * One harvested label -> the company names inside it. Posts carry labels like "INFOSYS MASS", "Amazon Work From Home Jobs | Bulk"
 * or "Oracle & Konrad" (two employers in one headline). Strips the noise tail, keeps what is left of a "|" label, splits "A & B"
 * into two names unless it is a known single company, and drops shouted or comma-ridden sentences.
 * @param {string} raw @returns {string[]}
 */
export function expandName(raw) {
  let n = cleanName(String(raw || '').split('|')[0]);
  for (let i = 0; i < 3; i++) n = n.replace(NOISE_TAIL, '').trim();
  if (!n || /,/.test(n) || (/^[^a-z]+$/.test(n) && n.split(' ').length > 3)) return [];
  const split = n.split(/\s+&\s+/);
  const parts = ONE_COMPANY.test(n) || split.some((x) => /^(co|company|sons|inc|ltd|llc|llp|corp|partners)\.?$/i.test(x)) ? [n] : split;
  return parts.map(cleanName).filter((x) => okName(x));
}

/** Company names from one post's text. Order of trust: an explicit "Company:" field, then "<Name> <Hiring|Recruitment|Off Campus ...>", then "<Name> - <Role>" after a siren emoji. */
export function companyFromPost(text) {
  let m = /Company\s*[:\-]\s*([^💼📍💰🎓🔗📅|\n]{2,60}?)(?=\s+(?:Role|Location|Salary|Qualification|Experience|Batch|Apply)\b|\s*[💼📍💰🎓🔗]|$)/u.exec(text);
  if (m && okName(cleanName(m[1]))) return cleanName(m[1]);
  m = /^\W*(.{2,60}?)\s+(?:Freshers?\s+)?(?:Recruitment|Hiring|Off[- ]?Campus|Walk[- ]?in|Job Alert|Internship|Drive)\b/iu.exec(text);
  if (m && okName(cleanName(m[1]))) return cleanName(m[1]);
  m = /^\W*(.{2,40}?)\s+[—–-]\s+(?:Internship|Off|Associate|Software|Graduate|Engineer|Analyst|Trainee)/iu.exec(text);
  if (m && okName(cleanName(m[1]))) return cleanName(m[1]);
  return null;
}

/** Company names from one channel page's HTML. NFKC folds the mathematical-bold letters some posts use back to ASCII. */
export function extractCompanies(html) {
  const out = [];
  for (const m of html.matchAll(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/g)) {
    const text = decode(m[1].replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, ' ')).normalize('NFKC').replace(/\s+/g, ' ').trim();
    const name = companyFromPost(text);
    if (name) out.push(...expandName(name));
  }
  return out;
}

async function page(channel, before) {
  const r = await fetch(`https://t.me/s/${channel}${before ? `?before=${before}` : ''}`, { signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; career-ops telegram-companies)' } });
  if (!r.ok) throw new Error(`${channel}: HTTP ${r.status}`);
  const html = await r.text();
  const ids = [...html.matchAll(/data-post="[^/]+\/(\d+)"/g)].map((x) => Number(x[1]));
  return { html, oldest: ids.length ? Math.min(...ids) : 0 };
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const channels = (opt('--channels', DEFAULT_CHANNELS.join(',')) || '').split(',').filter((c) => /^[A-Za-z0-9_]{5,32}$/.test(c));
  const pages = Math.min(Number(opt('--pages', 5)) || 5, 20);
  mkdirSync(DATA, { recursive: true });
  const file = join(DATA, 'telegram-companies.txt');
  if (argv.includes('--clean')) { // rewrite an existing list through expandName, keeping first-seen order
    const seen = new Set(); const kept = [];
    for (const l of (existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [])) for (const n of expandName(l)) { const k = n.toLowerCase().replace(/[^a-z0-9]/g, ''); if (k && !seen.has(k)) { seen.add(k); kept.push(n); } }
    writeFileSync(file, kept.join('\n') + '\n'); console.log(`telegram-companies: cleaned list, ${kept.length} names`); return;
  }
  const key = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const have = new Set((existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []).map(key));
  const known = new Set((existsSync(join(JOBAPPLY, 'companies.txt')) ? readFileSync(join(JOBAPPLY, 'companies.txt'), 'utf8').split('\n') : []).map((l) => key(l.split(',')[0])));
  let added = 0; const stats = {};
  for (const ch of channels) {
    stats[ch] = { names: new Set(), fresh: 0 };
    let before = 0;
    for (let p = 0; p < pages; p++) {
      let res; try { res = await page(ch, before); } catch (e) { console.error(e.message); break; }
      for (const name of extractCompanies(res.html)) {
        const k = key(name); if (!k) continue; stats[ch].names.add(k);
        if (have.has(k)) continue; stats[ch].fresh++;
        have.add(k); appendFileSync(file, name + '\n'); added++;
        if (!known.has(k)) console.log(`  new lead: ${name}`);
      }
      if (!res.oldest || res.oldest === before) break; before = res.oldest;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  for (const [ch, st] of Object.entries(stats)) console.log(`  ${ch}: ${st.names.size} distinct employers, ${st.fresh} new to our lists`);
  console.log(`telegram-companies: ${added} names added to ${file}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exit(1); });
