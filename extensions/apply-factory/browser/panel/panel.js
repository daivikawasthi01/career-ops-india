// Side panel. Everything shown on screen comes from page text, so nodes are built with textContent only.
const app = document.getElementById('app');

// Tell the background this window's side panel is open (the copy drawn inside a web page is an iframe and does not count).
// The port also reconnects if the background worker was restarted.
if (window === window.top) {
  const announceOpen = async () => {
    const win = await chrome.windows.getCurrent().catch(() => null);
    if (!win) return;
    const port = chrome.runtime.connect({ name: 'sidepanel' });
    port.postMessage({ windowId: win.id });
    port.onDisconnect.addListener(() => setTimeout(announceOpen, 500));
  };
  announceOpen();
}
let tabId = null;
let st = null;
let pending = false;
let signature = '';
let notice = '';
let siteNote = '';
const job = { key: '', ctx: null, pre: null, score: null, busy: '', confirm: false, result: '', error: '' };
const covers = {};
const drafts = {};

const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, tabId, ...extra });

const SOURCE = { fact: 'From your profile', kb: 'Your earlier answer', similar: 'Matched a similar question', draft: 'Drafted from your CV', user: 'Typed by you', report: 'From your evaluation of this job' };
const MODES = [['off', 'Off'], ['watch', 'Watch'], ['assist', 'Fill']];
const MODE_NOTE = {
  off: 'Not reading this site.',
  watch: 'Learns what you type. Fills nothing.',
  assist: 'Fills known answers and learns what you type.',
};

function items() {
  return Object.entries(st.frames || {}).flatMap(([frameId, f]) => (f.items || []).map((i) => ({ ...i, frameId })));
}

function siteCard() {
  const idle = !st.injected && st.siteMode !== 'off';
  return h('section', { class: 'stock' },
    h('p', { class: 'host', text: st.host }),
    h('div', { class: 'groove', role: 'radiogroup', 'aria-label': 'Mode for this site' },
      MODES.map(([value, name]) => h('button', {
        role: 'radio', 'aria-checked': String(st.siteMode === value), text: name,
        onclick: async () => { await send('set-mode', { host: st.host, mode: value }); refresh(); },
      }))),
    h('p', { class: 'note', text: idle ? 'Not active on this site yet.' : MODE_NOTE[st.siteMode] }),
    idle && st.host && h('div', { class: 'row' },
      h('button', { class: 'btn btn--ink btn--small', text: 'Watch this tab', onclick: watchTab }),
      h('button', { class: 'btn btn--card btn--small', text: 'Always on for this site', onclick: enableSite })),
    siteNote && h('p', { class: 'note warn', text: siteNote }),
    st.granted && h('div', { class: 'row' },
      h('button', { class: 'btn btn--card btn--small', text: 'Turn off for this site', onclick: async () => { await send('disable-site', { host: st.host }); refresh(); } })));
}

async function watchTab() {
  siteNote = '';
  const res = await send('watch-tab');
  if (res?.error) siteNote = `Chrome would not let the extension in: ${res.error}. Click the Apply icon on this tab and try again, or use "Always on for this site".`;
  setTimeout(refresh, 1500);
  render();
}

async function enableSite() {
  siteNote = '';
  let granted = false;
  try { granted = await chrome.permissions.request({ origins: [`https://${st.host}/*`] }); } catch (e) { siteNote = `Chrome refused the request: ${e.message}`; }
  if (!granted) { siteNote = siteNote || `Access to ${st.host} was not granted, so nothing was changed.`; render(); return; }
  const res = await send('enable-site', { host: st.host });
  if (res?.error) { siteNote = `Could not turn it on: ${res.error}`; render(); return; }
  await chrome.tabs.reload(tabId);
}

function summary(all) {
  const fillable = all.filter((i) => i.status === 'fill' || i.status === 'resume');
  const filled = fillable.filter((i) => i.filled).length;
  const draftable = all.filter((i) => i.status === 'draftable').length;
  const done = fillable.length > 0 && filled === fillable.length;
  return h('section', { class: 'stock' },
    h('div', { class: 'count' },
      h('span', { class: 'figure', text: String(filled) }),
      h('span', { text: fillable.length ? `of ${fillable.length} known answers filled` : 'known answers on this page' }),
      done && h('span', { class: 'settled', text: 'Done' })),
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn--ink', text: 'Fill answers', disabled: filled === fillable.length, onclick: () => send('fill-known') }),
      h('button', { class: 'btn btn--card', text: 'Draft the rest', disabled: !draftable || !st.server?.llm?.ok, onclick: () => send('draft-all') })));
}

function sourceLine(i) {
  const bits = [SOURCE[i.source]];
  if (i.note && i.source === 'similar') bits.push(`"${i.note}"`);
  return h('span', { class: 'source', text: bits.filter(Boolean).join(': ') });
}

function labelButton(i) {
  return h('button', { class: 'label', text: i.label, title: 'Show on the page', onclick: () => send('focus', { id: i.id }) });
}

function filledCard(i) {
  const isResume = i.status === 'resume';
  return h('article', { class: 'stock field' },
    h('header', {}, labelButton(i), isResume ? h('span', { class: 'source', text: i.note || 'Your CV' }) : sourceLine(i)),
    isResume && i.filled && h('p', { text: i.value }),
    !isResume && h('input', {
      value: i.value ?? '', 'aria-label': i.label,
      onchange: (e) => send('fill-one', { id: i.id, value: e.target.value, source: 'user' }),
    }),
    i.reason && h('p', { class: 'why', text: i.reason }),
    !i.filled && h('div', { class: 'row' }, h('button', { class: 'btn btn--card btn--small', text: 'Fill', onclick: () => send('fill-one', { id: i.id, value: i.value, source: i.source }) })));
}

function needsCard(i) {
  if (i.status === 'cover') return coverCard(i);
  const body = {
    draftable: () => [
      h('p', { class: 'why', text: i.hint ? `You have "${i.hint}" saved, but no option matches it.` : 'No saved answer yet.' }),
      h('div', { class: 'row' }, h('button', { class: 'btn btn--card btn--small', text: 'Draft', disabled: !st.server?.llm?.ok, onclick: () => send('draft', { id: i.id }) }),
        !st.server?.llm?.ok && h('span', { class: 'why', text: 'Needs the local model.' }))],
    drafting: () => [h('p', { class: 'why', text: 'Writing.' })],
    draft: () => [
      h('textarea', { 'aria-label': i.label, oninput: (e) => { drafts[i.id] = e.target.value; } }, drafts[i.id] ?? i.value ?? ''),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn--ink btn--small', text: 'Use this answer', onclick: () => send('fill-one', { id: i.id, value: drafts[i.id] ?? i.value, source: 'draft' }) }),
        h('button', { class: 'btn btn--card btn--small', text: 'Draft again', onclick: () => send('draft', { id: i.id }) }))],
    unknown: () => [h('p', { class: 'why', text: i.reason?.includes('CV') ? i.reason : 'New question. Answer it on the page and I learn it.' })],
    manual: () => [h('p', { class: 'why', text: i.reason || 'Yours to answer.' })],
    offline: () => [h('p', { class: 'why', text: i.reason || 'Server offline.' })],
  }[i.status];
  return h('article', { class: 'stock field' },
    h('header', {}, labelButton(i), i.status === 'draft' && h('span', { class: 'source', text: SOURCE.draft })),
    body ? body() : null);
}

function group(title, cards) {
  return cards.length ? h('section', { class: 'group' }, h('h2', { text: `${title} (${cards.length})` }), cards) : null;
}


// ---- job card: checks, quick score, tailor, mark applied ----
const callApi = (path, body) => send('api', { path, body });

// A reloaded extension does not update tabs that were already open: they keep the old page script until refreshed.
// Chrome keeps the manifest it loaded until the extension is reloaded, while the panel files are read fresh from disk. When the two
// differ, new features silently do not run, so say so plainly.
const oldManifest = () => window.AF_BUILD && chrome.runtime.getManifest().version !== window.AF_BUILD;

function oldManifestCard() {
  return h('section', { class: 'stock' },
    h('h2', { text: 'Chrome is running an old copy' }),
    h('p', { class: 'note', text: `Chrome has version ${chrome.runtime.getManifest().version} loaded, the files are ${window.AF_BUILD}. New features do not run until it reloads.` }),
    h('p', { class: 'note', text: 'Open chrome://extensions, find Apply and press its reload arrow. If this card stays, remove the extension and use Load unpacked on the browser folder again.' }));
}

function staleTab() {
  const mine = chrome.runtime.getManifest().version;
  return Object.values(st?.frames || {}).some((f) => f.diag?.v !== mine);
}

function staleCard() {
  return h('section', { class: 'stock' },
    h('h2', { text: 'This tab needs a refresh' }),
    h('p', { class: 'note', text: 'The extension was updated after this page opened, so the page is still running the old version without the new features.' }),
    h('div', { class: 'row' }, h('button', { class: 'btn btn--ink btn--small', text: 'Refresh this tab', onclick: () => chrome.tabs.reload(tabId) })));
}

function resetJob(key) {
  Object.assign(job, { key, ctx: null, pre: null, score: null, busy: '', confirm: false, result: '', error: '', autoDone: false, showScore: false });
}

async function jobContext() {
  if (!job.ctx) job.ctx = await send('job-context');
  return job.ctx;
}

async function runChecks() {
  job.busy = 'checks'; job.error = ''; render();
  const ctx = await jobContext();
  const res = await callApi('/preflight', { url: ctx.url, title: ctx.title, company: ctx.company });
  job.pre = res.error ? null : res;
  job.error = res.error || '';
  job.busy = '';
  render();
}

// Scores are kept per job for this panel session, so moving between the steps of one application never scores it again.
const scoreMemo = new Map();

async function runScore({ auto = false } = {}) {
  job.busy = 'score'; job.error = ''; render();
  const ctx = await jobContext();
  const memoKey = ctx.jd_key + '|' + ctx.title;
  if (auto && ctx.jd_text.length < 600) { job.busy = ''; job.autoDone = true; render(); return; } // not a job posting: stay quiet
  const res = scoreMemo.get(memoKey) || await callApi('/score', { title: ctx.title, company: ctx.company, jd_text: ctx.jd_text });
  if (!res.error) scoreMemo.set(memoKey, res);
  job.score = res.error ? null : res;
  job.error = auto ? '' : res.error || '';
  job.autoDone = true;
  job.busy = '';
  render();
}

// Shown first in the panel for every job page: the number, what to do about it, and the one-line reason.
function verdictBanner() {
  const sc = job.score;
  if (!sc && job.busy !== 'score') return null;
  if (!sc) return h('section', { class: 'stock verdict', 'data-action': 'wait' }, h('p', { class: 'note', text: 'Reading this job against your CV...' }));
  const a = sc.action || { key: 'tailor', label: 'Tailor first', why: '' };
  return h('section', { class: 'stock verdict', 'data-action': a.key },
    h('div', { class: 'count' }, h('span', { class: 'figure', text: sc.global.toFixed(1) }), h('span', { text: 'of 5' }), h('span', { class: `tone ${a.key === 'skip' ? 'stop' : a.key === 'apply' ? 'ok' : 'check'}`, text: a.label })),
    h('p', { class: 'note', text: sc.summary || a.why }),
    sc.dealbreakers?.length ? h('p', { class: 'why warn', text: `Breaks your rules: ${sc.dealbreakers.join('; ')}` }) : null,
    h('div', { class: 'row' },
      a.key === 'tailor' && h('button', { class: 'btn btn--ink btn--small', text: 'Tailor my CV', onclick: () => send('open-studio', { view: 'tailor' }) }),
      h('button', { class: 'btn btn--card btn--small', text: 'Full breakdown', onclick: () => { job.showScore = !job.showScore; render(); } })),
    job.showScore && scoreBlock(sc));
}

async function queueEvaluation() {
  const ctx = await jobContext();
  const res = await callApi('/queue', { url: ctx.url, title: ctx.title, company: ctx.company });
  job.result = res.error ? res.error : res.queued ? 'Added to data/pipeline.md. Run /career-ops pipeline for the full evaluation.' : res.reason;
  render();
}

async function markApplied() {
  const ctx = await jobContext();
  const slot = (st.server?.resumes || []).find((r) => r.exists);
  const res = await callApi('/applied', { url: ctx.url, title: ctx.title, company: ctx.company, resume: slot?.file || '' });
  job.confirm = false;
  job.result = res.error ? res.error : res.ok ? `Tracker row ${res.num} ${res.action} as Applied. Follow-up date seeded.` : `Not saved: ${res.steps.join('; ')}`;
  render();
}

function checkRows(pre) {
  const rows = [];
  const bl = pre.blacklist;
  rows.push(bl.status === 'hit' ? ['Stop', `On your do-not-apply list${bl.entry?.reason ? `: ${bl.entry.reason}` : ''}.`, 'stop']
    : bl.status === 'clear' ? ['OK', 'Not on your do-not-apply list.', 'ok'] : ['Check', 'Could not read the do-not-apply list.', 'check']);
  const d = pre.duplicate;
  rows.push(d.status === 'found' ? ['Check', `You already have ${d.rows.length} tracker row${d.rows.length > 1 ? 's' : ''} for this company or role.`, 'check']
    : d.status === 'clear' ? ['OK', 'No earlier application found.', 'ok'] : ['Check', 'Could not check earlier applications.', 'check']);
  const l = pre.liveness;
  rows.push(l.status === 'expired' ? ['Stop', 'The posting looks closed.', 'stop'] : l.status === 'active' ? ['OK', 'The posting looks open.', 'ok'] : ['Check', 'Could not confirm the posting is still open.', 'check']);
  const a = pre.aggregator;
  rows.push(a.status === 'aggregator' ? ['Check', `${a.host} is an aggregator. Treat this role as unconfirmed until you find it on the employer's own site.`, 'check'] : ['OK', "This is the employer's own site.", 'ok']);
  const r = pre.report;
  rows.push(r.status === 'match' ? ['OK', `Evaluated before: ${r.score ?? '?'}/5 (report ${r.num}). Its answers are used for drafts.`, 'ok']
    : r.status === 'company' ? ['Check', `A report exists for this company (${r.num}, ${r.score ?? '?'}/5). Make sure it is the same posting.`, 'check'] : ['Check', 'Not evaluated yet. Run the full evaluation for the real score.', 'check']);
  return rows;
}

function scoreBlock(sc) {
  return h('div', { class: 'score' },
    h('div', { class: 'count' }, h('span', { class: 'figure', text: sc.global.toFixed(1) }), h('span', { text: 'of 5' })),
    h('p', { class: 'host', text: sc.verdict }),
    sc.dealbreakers?.length ? h('p', { class: 'why warn', text: `Breaks your own rules: ${sc.dealbreakers.join('; ')}` }) : null,
    sc.dimensions.map((d) => h('div', { class: 'dim' },
      h('p', {}, h('span', { class: 'host', text: d.name }), ' ', h('span', { class: 'figure small', text: `${d.score}/5` })),
      d.evidence && h('p', { class: 'note', text: d.evidence }))),
    h('p', { class: 'note', text: `Quick score from the local model${sc.thin ? ', on little job text' : ''}. The full evaluation in career-ops is the record.` }),
    h('div', { class: 'row' }, h('button', { class: 'btn btn--card btn--small', text: 'Run full evaluation', onclick: queueEvaluation })));
}

function jobCard() {
  const busy = job.busy;
  return h('section', { class: 'stock' },
    h('h2', { text: 'This job' }),
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn--card', text: busy === 'checks' ? 'Checking' : 'Check this job', disabled: !!busy, onclick: runChecks }),
      h('button', { class: 'btn btn--card', text: busy === 'score' ? 'Scoring' : 'Score it', disabled: !!busy || !st.server?.llm?.ok, onclick: () => runScore() })),
    job.error && h('p', { class: 'why warn', text: job.error }),
    job.pre && h('ul', { class: 'checks' }, checkRows(job.pre).map(([word, text, tone]) => h('li', {}, h('span', { class: `tone ${tone}`, text: word }), ' ', text))),
    job.score && !job.showScore && h('p', { class: 'note', text: `Scored ${job.score.global.toFixed(1)} of 5, shown at the top.` }),
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn--ink', text: 'Tailor my CV', onclick: () => send('open-studio', { view: 'tailor' }) }),
      h('button', { class: 'btn btn--card', text: 'Mark as applied', onclick: () => { job.confirm = true; render(); } })),
    job.confirm && h('div', { class: 'row' },
      h('p', { class: 'note', text: `Add ${job.ctx?.company || 'this company'} to your tracker as Applied?` }),
      h('button', { class: 'btn btn--ink btn--small', text: 'Confirm', onclick: markApplied }),
      h('button', { class: 'btn btn--card btn--small', text: 'Cancel', onclick: () => { job.confirm = false; render(); } })),
    job.result && h('p', { class: 'note', text: job.result }));
}

function attentionCards(all) {
  const frames = Object.values(st.frames || {});
  const missing = frames.flatMap((f) => f.missing || []);
  const warns = frames.flatMap((f) => f.warnings || []);
  return [
    missing.length ? h('section', { class: 'stock' },
      h('h2', { text: `${missing.length} required field${missing.length > 1 ? 's' : ''} empty` }),
      missing.map((m) => h('button', { class: 'label', text: m.label, onclick: () => send('focus', { id: m.id }) }))) : null,
    warns.length ? h('section', { class: 'stock' },
      h('h2', { text: 'Questions that can reject you' }),
      warns.map((w) => h('div', {}, h('button', { class: 'label', text: w.label, onclick: () => send('focus', { id: w.id }) }), h('p', { class: 'why warn', text: w.why })))) : null,
  ];
}

async function draftCover(i) {
  covers[i.id] = { ...(covers[i.id] || {}), busy: true }; render();
  const ctx = await jobContext();
  const res = await callApi('/cover', { url: ctx.url, title: ctx.title, company: ctx.company, jd_text: ctx.jd_text });
  covers[i.id] = res.error ? { error: res.error } : { text: res.text, fromReport: res.from_report };
  render();
}

async function attachCover(i) {
  const ctx = await jobContext();
  const pdf = await callApi('/cover/pdf', { text: covers[i.id].text, company: ctx.company });
  if (pdf.error) { covers[i.id].error = pdf.error; return render(); }
  const res = await send('attach-file', { kind: 'cover', name: pdf.name, base64: pdf.base64 });
  covers[i.id].done = res?.error ? res.error : `Attached ${pdf.name}.`;
  render();
}

function coverCard(i) {
  const c = covers[i.id] || {};
  return h('article', { class: 'stock field' },
    h('header', {}, labelButton(i)),
    !c.text && h('div', { class: 'row' },
      h('button', { class: 'btn btn--card btn--small', text: c.busy ? 'Writing' : 'Draft cover letter', disabled: c.busy || !st.server?.llm?.ok, onclick: () => draftCover(i) }),
      !st.server?.llm?.ok && h('span', { class: 'why', text: 'Needs the local model.' })),
    c.text && h('textarea', { 'aria-label': 'Cover letter', oninput: (e) => { covers[i.id].text = e.target.value; } }, c.text),
    c.text && h('div', { class: 'row' },
      h('button', { class: 'btn btn--ink btn--small', text: 'Attach as PDF', onclick: () => attachCover(i) }),
      h('button', { class: 'btn btn--card btn--small', text: 'Draft again', onclick: () => draftCover(i) })),
    c.fromReport && h('p', { class: 'why', text: 'Started from the draft in your evaluation report.' }),
    c.error && h('p', { class: 'why warn', text: c.error }),
    c.done && h('p', { class: 'why', text: c.done }));
}

function setupCard() {
  const cmd = window.AF_SERVER_CMD || 'orchestrator.py serve';
  const plain = st.error === 'server offline';
  return h('section', { class: 'stock' },
    h('h2', { text: plain ? 'Start the local server' : 'The server needs attention' }),
    h('p', { class: 'note', text: plain ? 'Apply keeps your answers on this Mac. Run this in a terminal and leave it open:' : st.error }),
    plain && h('p', { class: 'cmd', text: cmd }),
    h('div', { class: 'row' },
      plain && h('button', { class: 'btn btn--card btn--small', text: 'Copy command', onclick: () => navigator.clipboard.writeText(cmd) }),
      h('button', { class: 'btn btn--ink btn--small', text: 'Check again', onclick: refresh })));
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

async function replaceCv(kind, file) {
  if (!file) return;
  const res = await send('upload-resume', { kind, base64: await toBase64(file) });
  notice = res.error ? res.error : `Saved ${res.file}. The old one is kept as .previous.pdf.`;
  refresh();
}

function cvCard() {
  const rows = st.server?.resumes;
  if (!rows) return null;
  return h('section', { class: 'stock' },
    h('h2', { text: 'Your CV files' }),
    rows.map((r) => {
      const input = h('input', { type: 'file', accept: 'application/pdf', class: 'visually-hidden', 'aria-label': `Choose a PDF for ${r.label}`, onchange: (e) => replaceCv(r.kind, e.target.files[0]) });
      return h('div', { class: 'cv' },
        h('div', {}, h('p', { class: 'host', text: r.label }),
          h('p', { class: 'note', text: r.exists ? r.file : r.uses_default ? 'Not added. The default CV is used.' : 'Not added yet.' })),
        input,
        h('button', { class: 'btn btn--card btn--small', text: r.exists ? 'Replace' : 'Add', onclick: () => input.click() }));
    }),
    h('div', { class: 'row' }, h('button', { class: 'btn btn--ink btn--small', text: 'Open CV studio', onclick: () => send('open-studio', { view: 'edit' }) })),
    notice && h('p', { class: 'note', text: notice }));
}

function footer() {
  const c = st.server?.counts;
  const llm = st.server?.llm;
  return h('footer', { class: 'foot' },
    h('label', { class: 'switch' },
      h('input', { type: 'checkbox', checked: st.auto, onchange: async (e) => { await send('set-auto', { auto: e.target.checked }); } }),
      h('span', { text: 'Fill known answers when a form opens' })),
    h('label', { class: 'switch' },
      h('input', { type: 'checkbox', checked: st.autoOpen !== false, onchange: async (e) => { await send('set-auto', { autoOpen: e.target.checked }); } }),
      h('span', { text: 'Open this panel on the page when a form is found' })),
    h('button', { class: 'btn btn--card btn--small', text: window.AFTheme.current() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', onclick: () => { window.AFTheme.toggle(); render(); } }),
    h('p', { text: `Version ${chrome.runtime.getManifest().version}` }),
    c && h('p', { text: `${c.answers} answers learned, ${c.samples} writing samples.` }),
    c?.pending > 0 && h('p', {}, `${c.pending} to learn when the model is back. `, h('button', { class: 'label', text: 'Retry now', onclick: async () => { await send('retry'); refresh(); } })),
    st.server?.last_capture?.new != null && h('p', { text: `Last save: ${st.server.last_capture.new} new, ${st.server.last_capture.reinforced} confirmed, ${st.server.last_capture.corrected} changed.` }),
    llm && !llm.ok && h('p', { text: 'Local model is off. Known answers still fill; drafts need Ollama running.' }));
}

function render() {
  const nodes = [];
  const llm = st?.server?.llm;
  nodes.push(h('header', { class: 'top' },
    h('h1', { text: 'Apply' }),
    st && !st.error && h('span', { class: 'link', 'data-ok': String(!!llm?.ok), text: llm?.ok ? `Local model ready: ${llm.chat_model}` : 'Local model off' })));

  if (oldManifest()) nodes.push(oldManifestCard());
  if (!st || st.error) { nodes.push(setupCard()); }
  else if (!st.host) { nodes.push(h('p', { class: 'empty', text: 'Open an application form and I will pick it up.' })); }
  else {
    const all = items();
    if (st.injected && staleTab()) nodes.push(staleCard());
    if (st.siteMode !== 'off' && st.injected) nodes.push(verdictBanner());
    nodes.push(siteCard());
    if (st.siteMode !== 'off' && st.injected) nodes.push(jobCard());
    if (st.siteMode === 'assist' && all.length) {
      nodes.push(summary(all), ...attentionCards(all));
      const ready = all.filter((i) => i.status === 'fill' || i.status === 'resume');
      const needs = all.filter((i) => ['draftable', 'drafting', 'draft', 'unknown', 'manual', 'offline', 'cover'].includes(i.status));
      nodes.push(group('Needs you', needs.map(needsCard)), group('Ready', ready.map(filledCard)));
    } else if (st.siteMode === 'assist') {
      const d = Object.values(st.frames || {}).map((f) => f.diag).find((x) => x && x.inputs !== undefined);
      nodes.push(h('p', { class: 'empty', text: st.injected ? 'No application form on this page yet.' : 'Open an application form and I will pick it up.' }));
      if (d) nodes.push(h('p', { class: 'empty', text: d.error ? `Scan failed: ${d.error}` : `Seen on this page: ${d.inputs} fields, ${d.readable} readable (needs 3).` }));
    }
    nodes.push(cvCard(), footer());
  }
  app.replaceChildren(...nodes.filter(Boolean));
}

function maybeRender() {
  const a = document.activeElement;
  if (app.contains(a) && /^(INPUT|TEXTAREA)$/.test(a.tagName) && a.type !== 'checkbox') { pending = true; return; }
  pending = false;
  render();
}

async function refresh() {
  const forced = Number(new URLSearchParams(location.search).get('tab')); // lets the e2e test point the panel at another tab
  const [t] = forced ? [{ id: forced }] : await chrome.tabs.query({ active: true, currentWindow: true });
  if (!t) return;
  tabId = t.id;
  st = await send('get-state');
  if (!st || st.error === 'no reply') st = { error: 'server offline' };
  const key = `${st.host}|${(Object.values(st.frames || {})[0] || {}).url || ''}`;
  if (key !== job.key) resetJob(key);
  if (st.injected && st.siteMode !== 'off' && st.server?.llm?.ok && !job.score && !job.busy && !job.autoDone) runScore({ auto: true });
  const sig = JSON.stringify([key, st.siteMode, st.error, st.frames, st.server?.llm?.ok, st.server?.counts, st.server?.resumes, notice, siteNote, job.busy, job.confirm, job.result, !!job.pre, !!job.score, job.showScore, job.score?.action?.key, Object.keys(covers).map((k) => [k, !!covers[k].text, covers[k].busy, covers[k].done])]);
  if (sig !== signature) { signature = sig; maybeRender(); }
}

let timer;
const soon = () => { clearTimeout(timer); timer = setTimeout(refresh, 120); };
chrome.runtime.onMessage.addListener((m) => { if (m.type === 'state-changed') soon(); });
chrome.tabs.onActivated.addListener(soon);
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === 'complete') soon(); });
app.addEventListener('focusout', () => { if (pending) setTimeout(() => { if (pending) maybeRender(); }, 50); });
setInterval(refresh, 15000);
refresh();
