#!/usr/bin/env node
/**
 * careers-review.mjs: a local page to review data/careers-discovery.tsv.
 *
 *   node tools/careers-review.mjs            # then open http://127.0.0.1:8787
 *
 * Shows every company the discovery run has finished (it refreshes while the run goes on), with a flag
 * (bot-blocked, wrong domain, no domain, board differs, search empty, ok), the found domain and careers URL, and the
 * board in portals.yml. Per row: tick, cross, or edit the careers URL. Your decisions go to data/careers-review.json.
 * It never edits portals.yml or the discovery TSV, and listens on loopback only.
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isMainModule } from '../lib/is-main-module.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { outcomeOf } from '../lib/careers-pass2.mjs';

const ROOT = getCareerOpsRoot();
const TSV = process.env.CAREER_OPS_DISCOVERY || join(ROOT, 'data', 'careers-discovery.tsv');
const PASS2 = process.env.CAREER_OPS_PASS2 || join(ROOT, 'data', 'careers-pass2.tsv');
const REVIEW = process.env.CAREER_OPS_REVIEW || join(ROOT, 'data', 'careers-review.json');
const PORT = Number(process.env.PORT) || 8787;

/** One short flag per row, from what the pipeline recorded. */
export function flagOf(r) {
  const text = `${r.reason} ${r.evidence}`.toLowerCase();
  if (r.status === 'accepted') return 'ok';
  if (/search returned no results/.test(text)) return 'search-empty';
  if (/l3=blocked|access denied|blocked/.test(text)) return 'bot-blocked';
  if (!r.domain) return 'no-domain';
  if (/same company is "(no|unsure)"|verifier: not a careers page|not an l0 candidate/.test(text)) return 'wrong-domain?';
  if (/ats_vs_board/.test(text) || r.board_match === 'different') return 'board-differs';
  if (/reachable/.test(text)) return 'unreachable';
  return 'review';
}

export function parseTsv(text) {
  const [head, ...lines] = text.split('\n').filter(Boolean);
  const cols = head.split('\t');
  return lines.map((l) => { const c = l.split('\t'); const r = Object.fromEntries(cols.map((k, i) => [k, c[i] ?? ''])); r.flag = flagOf(r); return r; });
}

/** Pass 2 result per company (when there is one) replaces the pass 1 flag: its outcome, the careers page it kept, and the jobs it read. */
export function mergePass2(rows, p2rows) {
  const by = new Map(p2rows.map((r) => [String(r.company).toLowerCase(), r]));
  return rows.map((r) => {
    const p = by.get(String(r.company).toLowerCase());
    if (!p) return r;
    const outcome = p.outcome || outcomeOf(p.final_status, p.jobs_india);
    return { ...r, p1_flag: r.flag, flag: outcome, p1_url: r.careers_url, careers_url: p.careers_url || r.careers_url, alternatives: (() => { try { return JSON.parse(p.alternatives || '[]'); } catch { return []; } })(), jobs_total: p.jobs_total, jobs_india: p.jobs_india, sample: p.sample_titles, why: `${p.final_status}${p.notes ? ' | ' + p.notes : ''}` };
  });
}

const readReview = () => { try { return JSON.parse(readFileSync(REVIEW, 'utf8')); } catch { return {}; } };
function saveReview(obj) {
  mkdirSync(dirname(REVIEW), { recursive: true });
  const tmp = `${REVIEW}.tmp`; writeFileSync(tmp, JSON.stringify(obj, null, 1)); renameSync(tmp, REVIEW);
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Careers review</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--mut:#666;--line:#ddd;--ok:#1a7f37;--bad:#b3261e;--warn:#9a6700}
@media(prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee;--mut:#999;--line:#333;--ok:#4cc26a;--bad:#ff7b72;--warn:#e3b341}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px system-ui,sans-serif}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
button,select,input{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:4px 8px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top}
td.u input{width:100%;min-width:220px}.mut{color:var(--mut);font-size:12px}
.ok,.pass{color:var(--ok)}.bad,.not-found{color:var(--bad)}.warn{color:var(--warn)}.no-india-jobs{color:#b7791f}.india-unknown{color:#a8a000}.no-jobs-read{color:#d9730d}.blocked{color:var(--mut)}.check-identity{color:#8250df}.act button{cursor:pointer;font-size:16px}
tr.done{opacity:.55}
@media(max-width:700px){td.hide{display:none}th.hide{display:none}}
</style></head><body>
<header><b>Careers review</b><span id="count" class="mut"></span>
<select id="flag"><option value="">all flags</option></select>
<select id="dec"><option value="">any decision</option><option value="todo">not reviewed</option><option value="ok">ticked</option><option value="bad">crossed</option></select>
<input id="q" placeholder="search company"></header>
<table><thead><tr><th>Company</th><th>Flag</th><th>Domain</th><th>Careers URL (editable)</th><th class="hide">Jobs / India</th><th class="hide">Why</th><th>Review</th></tr></thead><tbody id="rows"></tbody></table>
<script>
let rows=[],rev={};
const $=id=>document.getElementById(id);
const OUT=['pass','no-india-jobs','india-unknown','no-jobs-read','blocked','check-identity','not-found'];
const cls=f=>OUT.includes(f)?f:f==='ok'?'ok':(f==='bot-blocked'||f==='review'?'warn':'bad');
async function load(){const[a,b]=await Promise.all([fetch('/api/rows').then(r=>r.json()),fetch('/api/review').then(r=>r.json())]);rows=a;rev=b;
 const fl=[...new Set(rows.map(r=>r.flag))].sort();const cur=$('flag').value;$('flag').innerHTML='<option value="">all flags</option>'+fl.map(f=>'<option'+(f===cur?' selected':'')+'>'+f+'</option>').join('');draw();}
function draw(){const f=$('flag').value,d=$('dec').value,q=$('q').value.toLowerCase();
 const list=rows.filter(r=>(!f||r.flag===f)&&(!q||r.company.toLowerCase().includes(q))&&(!d||(d==='todo'?!rev[r.company]?.decision:rev[r.company]?.decision===d)));
 $('count').textContent=list.length+' of '+rows.length+' | ticked '+Object.values(rev).filter(x=>x.decision==='ok').length+' | crossed '+Object.values(rev).filter(x=>x.decision==='bad').length;
 $('rows').innerHTML='';
 for(const r of list){const v=rev[r.company]||{};const tr=document.createElement('tr');if(v.decision)tr.className='done';
  const url=v.careers_url??r.careers_url;
  tr.innerHTML='<td><b></b></td><td class="'+cls(r.flag)+'"></td><td></td><td class="u"><input></td><td class="hide mut"></td><td class="hide mut"></td><td class="act"></td>';
  const c=tr.children;c[0].firstChild.textContent=r.company;c[1].textContent=r.flag;c[2].textContent=r.domain||'-';
  const inp=c[3].firstChild;inp.value=url;inp.onchange=()=>save(r.company,{careers_url:inp.value});
  if(url){const a=document.createElement('a');a.href=url;a.target='_blank';a.rel='noopener';a.textContent=' open';c[3].append(a);}
  if((r.alternatives||[]).length){const box=document.createElement('div');box.className='mut';box.append('Other pages found: ');for(const al of r.alternatives){const b=document.createElement('button');b.textContent=al.u.replace(/^https?:\/\/(www\.)?/,'').slice(0,40)+' ('+al.v+')';b.title='use this page';b.style.margin='2px';b.onclick=()=>{inp.value=al.u;save(r.company,{careers_url:al.u});};box.append(b);const o=document.createElement('a');o.href=al.u;o.target='_blank';o.rel='noopener';o.textContent='\u2197';box.append(o,' ');}c[3].append(box);}
  c[4].textContent=r.jobs_total!==undefined?((r.jobs_total||'-')+' / '+(r.jobs_india||'-')+(r.sample?' | '+r.sample.slice(0,60):'')):((r.ats||'-')+' / '+(r.board_match||'-'));c[5].textContent=(r.why||r.reason||'').slice(0,140);
  for(const[k,t]of[['ok','\\u2714'],['bad','\\u2718']]){const b=document.createElement('button');b.textContent=t;b.title=k==='ok'?'correct':'wrong';if(v.decision===k)b.style.borderColor='currentColor';b.onclick=()=>save(r.company,{decision:v.decision===k?null:k});c[6].append(b);}
  $('rows').append(tr);}}
async function save(company,patch){rev[company]={...(rev[company]||{}),...patch};await fetch('/api/review',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({company,patch})});draw();}
for(const id of['flag','dec'])$(id).onchange=draw;$('q').oninput=draw;
load();setInterval(()=>{if(document.activeElement.tagName!=='INPUT')load();},30000);
</script></body></html>`;

export function makeServer() {
  return createServer((req, res) => {
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    if (req.method === 'GET' && req.url === '/') return send(200, 'text/html; charset=utf-8', PAGE);
    if (req.method === 'GET' && req.url === '/api/rows') return send(200, 'application/json', JSON.stringify(existsSync(TSV) ? mergePass2(parseTsv(readFileSync(TSV, 'utf8')), existsSync(PASS2) ? parseTsv(readFileSync(PASS2, 'utf8')) : []) : []));
    if (req.method === 'GET' && req.url === '/api/review') return send(200, 'application/json', JSON.stringify(readReview()));
    if (req.method === 'POST' && req.url === '/api/review') {
      let body = ''; req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
      req.on('end', () => {
        try {
          const { company, patch } = JSON.parse(body);
          if (typeof company !== 'string' || !patch || typeof patch !== 'object') throw new Error('bad request');
          const clean = {};
          if ('decision' in patch) clean.decision = patch.decision === 'ok' || patch.decision === 'bad' ? patch.decision : null;
          if (typeof patch.careers_url === 'string') clean.careers_url = patch.careers_url.slice(0, 500);
          const all = readReview(); all[company] = { ...(all[company] || {}), ...clean, at: new Date().toISOString() };
          saveReview(all); send(200, 'application/json', '{"ok":true}');
        } catch { send(400, 'application/json', '{"ok":false}'); }
      });
      return;
    }
    send(404, 'text/plain', 'not found');
  });
}

if (isMainModule(import.meta.url)) {
  makeServer().listen(PORT, '127.0.0.1', () => console.log(`Careers review: http://127.0.0.1:${PORT}  (reads ${TSV})`));
}
