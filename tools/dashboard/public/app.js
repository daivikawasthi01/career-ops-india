// Pipeline dashboard: plain modules, no build step. All data comes from the local server's /api routes.
const TABS = [['overview', 'Overview'], ['jobs', 'Jobs'], ['sources', 'Sources'], ['names', 'Names'], ['boards', 'Boards'], ['campus', 'Campus'], ['runs', 'Runs']];
const main = document.getElementById('main');
const tabsEl = document.getElementById('tabs');

// ---- tiny helpers (text only: data never goes through innerHTML) ----
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const api = async (path, opts) => {
  const r = await fetch(`/api/${path}`, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `request failed (${r.status})`);
  return j;
};
const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const fmt = (n) => (n == null ? '-' : Number(n).toLocaleString('en-IN'));
function ago(iso) {
  if (!iso) return 'never';
  const t = Date.parse(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(t)) return String(iso);
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
function toast(msg) {
  const t = h('div', { class: 'toast', role: 'status', text: msg });
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}
const linkTo = (url, label) => (/^https?:\/\//.test(url || '') ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: label || url.replace(/^https?:\/\/(www\.)?/, '') }) : h('span', { text: url || '' }));

// ---- the four states ----
const skeleton = () => h('div', { class: 'skel', 'aria-busy': 'true', 'aria-label': 'Loading' }, h('i'), h('i'), h('i'));
const empty = (what, hint, action) => h('div', { class: 'state' }, h('strong', { text: what }), hint && h('span', { text: hint }), action);
const failed = (err, retry) => h('div', { class: 'state err', role: 'alert' }, h('strong', { text: 'This did not load' }), h('span', { text: err.message }), h('button', { class: 'btn small', type: 'button', onclick: retry, text: 'Try again' }));

/** Render `build(data)` into `host` with loading, error and empty handled in one place. */
async function load(host, fetcher, build) {
  host.replaceChildren(skeleton());
  try { host.replaceChildren(build(await fetcher())); }
  catch (err) { host.replaceChildren(failed(err, () => load(host, fetcher, build))); }
}

function table(cols, rows, { onEmpty } = {}) {
  if (!rows.length) return onEmpty || empty('Nothing here yet');
  return h('div', { class: 'tbl-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, cols.map((c) => h('th', { class: c.right ? 'r' : '', scope: 'col', text: c.label })))),
    h('tbody', {}, rows.map((r) => h('tr', {}, cols.map((c) => { const v = c.render ? c.render(r) : r[c.key]; return h('td', { class: `${c.right ? 'r ' : ''}${c.mono ? 'num' : ''}`.trim(), title: typeof v === 'string' ? v : null }, v ?? ''); }))))));
}

// ---- router: the tab and its filters live in the URL ----
function route() {
  const [path, qs = ''] = location.hash.replace(/^#\/?/, '').split('?');
  return { name: TABS.some(([id]) => id === path) ? path : 'overview', q: new URLSearchParams(qs) };
}
function go(name, params = {}) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
  location.hash = `#/${name}${q.size ? `?${q}` : ''}`;
}
tabsEl.append(...TABS.map(([id, label]) => h('a', { href: `#/${id}`, 'data-tab': id, text: label })));

// ---- background runs: one launcher for every mine.py run, one log panel ----
const STEP_IDS = ['freehire', 'internshala', 'jobspy', 'portals', 'ats', 'slow'];
let drawer = null; let poll = null; let launcher = null;
function closeDrawer() { clearInterval(poll); drawer?.remove(); drawer = null; }
function closeLauncher() { launcher?.remove(); launcher = null; }

function openDrawer(runId, label, after) {
  closeDrawer();
  const pre = h('pre', { text: 'Starting...' });
  const status = h('span', { class: 'chip live', text: 'running' });
  drawer = h('aside', { class: 'drawer', 'aria-label': `Log for ${label}` },
    h('div', { class: 'panel-h' }, h('span', {}, h('strong', { class: 'ink', text: label }), ' ', status), h('button', { class: 'btn small ghost', type: 'button', onclick: closeDrawer, text: 'Close' })), pre);
  document.body.append(drawer);
  const tick = async () => {
    try {
      const r = await api(`run/${encodeURIComponent(runId)}`);
      pre.textContent = r.log || 'No output yet.';
      pre.scrollTop = pre.scrollHeight;
      if (!r.running) {
        clearInterval(poll);
        status.className = `chip ${r.code === 0 ? 'ok' : 'bad'}`;
        status.textContent = r.code === 0 ? 'finished' : `exited ${r.code}`;
        after?.();
      }
    } catch (err) { pre.textContent = err.message; clearInterval(poll); }
  };
  tick(); poll = setInterval(tick, 2000);
}

/** The one place a run starts. `pre` preselects steps (from a row's Run button); empty means the complete run. */
async function openLauncher(pre = []) {
  closeLauncher();
  let feeders = [];
  try { feeders = (await api('sources')).feeders.map((f) => f.id); } catch { /* the steps still work */ }
  const state = { dry: true, all: pre.length === 0, picked: new Set(pre), armed: false };
  const body = h('div', { class: 'panel-b launch-b' });
  launcher = h('section', { class: 'panel launcher', role: 'dialog', 'aria-label': 'Run mine.py' },
    h('div', { class: 'panel-h' }, h('h2', { text: 'Run mine.py' }), h('button', { class: 'btn small ghost', type: 'button', onclick: closeLauncher, text: 'Close' })), body);
  document.body.append(launcher);

  const draw = () => {
    state.armed = false;
    const mode = h('div', { class: 'seg', role: 'group', 'aria-label': 'Mode' },
      h('button', { type: 'button', 'aria-pressed': String(state.dry), onclick: () => { state.dry = true; draw(); }, text: 'Dry run' }),
      h('button', { type: 'button', 'aria-pressed': String(!state.dry), onclick: () => { state.dry = false; draw(); }, text: 'Real run' }));
    const note = h('p', { class: 'small', text: state.dry
      ? 'Reads every chosen source and shows what would be added. Saves nothing, sends no Telegram ping, and skips the feeders.'
      : 'Saves new jobs to jobs.db, moves the schedule, sends a Telegram ping for new jobs, and runs the feeders that are due.' });
    const box = (id, label, disabled = false) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.picked.has(id) && !disabled, disabled, onchange: (e) => { e.target.checked ? state.picked.add(id) : state.picked.delete(id); } }), h('span', { text: label }));
    const everything = h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.all, onchange: (e) => { state.all = e.target.checked; draw(); } }), h('span', { class: 'ink', text: 'Everything (the complete run)' }));
    const pick = state.all ? null : h('div', { class: 'picks' },
      h('div', {}, h('div', { class: 'small', text: 'Scan steps' }), STEP_IDS.map((id) => box(id, id))),
      h('div', {}, h('div', { class: 'small', text: state.dry ? 'Feeders (real runs only)' : 'Feeders' }), feeders.map((id) => box(id, id, state.dry))));
    const go = h('button', { class: 'btn primary', type: 'button', text: state.dry ? 'Start dry run' : 'Start real run', onclick: async (e) => {
      const steps = state.all ? [] : [...state.picked].filter((id) => STEP_IDS.includes(id) || (!state.dry && feeders.includes(id)));
      if (!state.all && !steps.length) { toast('Pick at least one step'); return; }
      if (!state.dry && !state.armed) { state.armed = true; e.target.textContent = 'Confirm real run'; return; }
      try {
        const { runId, target } = await post('run', { steps, dry: state.dry });
        closeLauncher(); openDrawer(runId, target, () => { if (route().name === 'runs') render(); });
      } catch (err) { toast(err.message); state.armed = false; draw(); }
    } });
    body.replaceChildren(mode, note, everything, pick, h('div', { class: 'launch-go' }, go));
  };
  draw();
}
const runButton = (id, label = 'Run') => h('button', { class: 'btn small', type: 'button', onclick: () => openLauncher([id]), text: label });

// ---- views ----
function head(title, sub, ...actions) {
  return h('div', { class: 'head' }, h('div', {}, h('h1', { text: title }), sub && h('p', { text: sub })), h('div', { class: 'tools' }, ...actions));
}

async function viewOverview(q) {
  const body = h('div');
  main.replaceChildren(head('Overview', 'Where each stage of the pipeline stands, from the files on disk.'), body);
  await load(body, async () => {
    const [o, s, c] = await Promise.all([api('overview'), api('sources'), api('campus')]);
    return { o, s, c };
  }, ({ o, s, c }) => {
    const names = o.lists.filter((l) => l.id !== 'campus').reduce((a, l) => a + l.count, 0);
    const run = o.run || {};
    const pct = run.total ? Math.min(100, (run.done / run.total) * 100) : 0;
    const left = run.total && run.avgSeconds ? Math.round(((run.total - run.done) * run.avgSeconds) / 3600) : null;
    const lastFeeder = (id) => s.feeders.find((f) => f.id === id)?.last?.at;
    const attention = [];
    if (run.state === 'halted') attention.push(['Discovery run is paused', run.halt_reason || 'It will resume on its own; the supervisor log says when.', 'bad']);
    if (c.failing) attention.push([`${c.failing} campus pages fail to load`, 'Open Campus to see which and why.', 'warn']);
    if (o.jobs.empty) attention.push(['No jobs database yet', 'It is created by the first real mine.py run.', 'warn']);
    const never = s.feeders.filter((f) => !f.last).map((f) => f.id);
    if (never.length) attention.push([`${never.length} feeders have never run`, never.join(', '), 'warn']);

    const stat = (label, value, sub) => h('div', {}, h('span', { text: label }), h('span', { class: 'v', text: value }), h('span', { class: 'sub', text: sub }));
    return h('div', { class: 'grid' },
      h('div', { class: 'seams' },
        stat('Jobs found', fmt(o.jobs.total), `${fmt(o.jobs.byStatus?.new || 0)} new, last run ${ago(o.jobs.lastRun)}`),
        stat('Company names', fmt(names), 'Telegram, funding and directory'),
        stat('Boards tracked', fmt(o.boards.tracked), `${fmt(o.boards.jobBoards)} job boards, ${fmt(o.boards.searchQueries)} searches`),
        stat('Campus pages', fmt(o.campus.pages), `${fmt(o.campus.changes)} changes logged`)),
      h('div', { class: 'grid g2' },
        h('section', { class: 'panel' },
          h('div', { class: 'panel-h' }, h('h2', { text: 'Pipeline ledger' }), h('span', { class: 'small', text: 'names to boards to jobs' })),
          h('ol', { class: 'ledger' },
            h('li', { class: names ? 'done' : '' }, h('span', { class: 't', text: 'Names harvested' }), h('span', { class: 'num ink', text: fmt(names) }),
              h('span', { class: 'm', text: o.lists.filter((l) => l.id !== 'campus').map((l) => `${l.label} ${fmt(l.count)}, ${ago(l.updated)}`).join('; ') })),
            h('li', { class: run.state === 'running' ? 'open' : (run.done ? 'done' : '') }, h('span', { class: 't', text: 'Careers discovery' }), h('span', { class: 'chip ' + (run.state === 'running' ? 'live' : run.state === 'halted' ? 'bad' : ''), text: run.state || 'idle' }),
              h('span', { class: 'm' }, h('span', { class: 'num', text: `${fmt(run.done)} of ${fmt(run.total)} companies` }), left != null && run.state !== 'finished' ? `, about ${left} h left` : '', h('div', { class: 'meter', role: 'progressbar', 'aria-valuenow': Math.round(pct), 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: `width:${pct}%` })))),
            h('li', { class: o.boards.reviewed ? 'done' : '' }, h('span', { class: 't', text: 'ATS boards' }), h('span', { class: 'num ink', text: fmt(o.boards.reviewed) }),
              h('span', { class: 'm', text: `${fmt(o.boards.found)} found by the probe from ${fmt(o.boards.probed)} tries, ${fmt(o.boards.rejected)} rejected${o.probeRunning ? ', probe running' : ''}` })),
            h('li', { class: o.jobs.total ? 'done' : '' }, h('span', { class: 't', text: 'Jobs' }), h('span', { class: 'num ink', text: fmt(o.jobs.total) }),
              h('span', { class: 'm', text: `${fmt(o.jobs.employer)} confirmed at the employer; applied ${fmt(o.jobs.byStatus?.applied || 0)}, interested ${fmt(o.jobs.byStatus?.interested || 0)}` })))),
        h('section', { class: 'panel' },
          h('div', { class: 'panel-h' }, h('h2', { text: 'Needs attention' })),
          attention.length
            ? h('ul', { class: 'items' }, attention.map(([t, d, tone]) => h('li', {}, h('div', {}, h('div', { class: 'ink', text: t }), h('div', { class: 'small', text: d })), h('span', { class: `chip ${tone}`, text: tone === 'bad' ? 'paused' : 'check' }))))
            : empty('Nothing needs attention', 'Failures, paused runs and never-run feeders show up here.'))),
      o.run.supervisor?.length ? h('section', { class: 'panel' }, h('div', { class: 'panel-h' }, h('h2', { text: 'Supervisor log' }), h('span', { class: 'small', text: ago(o.run.tsvUpdated) + ' since the last row' })), h('div', { class: 'panel-b' }, h('pre', { class: 'mono', style: 'margin:0;white-space:pre-wrap', text: o.run.supervisor.join('\n') }))) : null);
  });
  const chip = document.getElementById('run-chip');
  api('overview').then((o) => { chip.hidden = false; chip.className = `chip ${o.run.state === 'running' ? 'live' : o.run.state === 'halted' ? 'bad' : ''}`; chip.textContent = `Discovery ${o.run.state || 'idle'}`; }).catch(() => { chip.hidden = true; });
}

async function viewJobs(q) {
  const status = q.get('status') || ''; const text = q.get('q') || '';
  const body = h('div');
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search title, company, location', value: text, 'aria-label': 'Search jobs', onkeydown: (e) => { if (e.key === 'Enter') go('jobs', { status, q: e.target.value }); } });
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Status' }, ['', 'new', 'interested', 'applied', 'ignore'].map((s) => h('button', { type: 'button', 'aria-pressed': String(s === status), onclick: () => go('jobs', { status: s, q: text }), text: s || 'All' })));
  main.replaceChildren(head('Jobs', 'Everything mine.py has found, newest first. Change a status here and it stays in jobs.db.'), h('div', { class: 'tools' }, seg, search), h('section', { class: 'panel flush' }, h('div', { class: 'panel-b' }, body)));
  await load(body, () => api(`jobs?limit=200&status=${encodeURIComponent(status)}&q=${encodeURIComponent(text)}`), (rows) => table([
    { label: 'Title', render: (r) => linkTo(r.employer_url || r.url, r.title) },
    { label: 'Company', key: 'company' },
    { label: 'Location', key: 'location' },
    { label: 'Found by', key: 'found_by' },
    { label: 'Source check', render: (r) => h('span', { class: `chip ${r.confidence === 'employer-confirmed' ? 'ok' : 'warn'}`, text: r.confidence === 'employer-confirmed' ? 'at employer' : 'unconfirmed' }) },
    { label: 'First seen', mono: true, render: (r) => (r.first_seen || '').slice(0, 10) },
    { label: 'Status', render: (r) => h('select', { class: 'input', 'aria-label': `Status for ${r.title}`, onchange: async (e) => { try { await post('jobs/status', { canonical_url: r.canonical_url, status: e.target.value }); toast('Status saved'); } catch (err) { toast(err.message); } } }, ['new', 'interested', 'applied', 'ignore'].map((s) => h('option', { value: s, selected: s === r.status, text: s }))) },
  ], rows, { onEmpty: empty('No jobs match', 'The jobs database fills after the first real mine.py run.', h('button', { class: 'btn primary small', type: 'button', onclick: () => openLauncher(), text: 'Run mine.py' })) }));
}

async function viewSources() {
  const body = h('div', { class: 'grid' });
  main.replaceChildren(head('Sources', 'Every step and feeder mine.py runs, and the job boards in portals.yml.'), body);
  await load(body, () => api('sources'), (s) => {
    const last = (r) => (r.last ? `${ago(r.last.at)}${r.last.coverage != null ? `, ${Math.round(r.last.coverage * 100)}% read` : ''}` : 'never');
        const section = (title, rows, cols) => h('section', { class: 'panel flush' }, h('div', { class: 'panel-h' }, h('h2', { text: title }), h('span', { class: 'small num', text: `${rows.length}` })), table(cols, rows));
    return h('div', { class: 'grid' },
      section('Scan steps', s.steps, [{ label: 'Step', render: (r) => h('span', { class: 'ink', text: r.id }) }, { label: 'Reads', key: 'detail' }, { label: 'Last run', render: last }, { label: '', right: true, render: (r) => runButton(r.id, 'Run') }]),
      section('Feeders', s.feeders, [{ label: 'Feeder', render: (r) => h('span', { class: 'ink', text: r.id }) }, { label: 'Schedule', key: 'detail' }, { label: 'Last run', render: last }, { label: '', right: true, render: (r) => runButton(r.id, 'Run') }]),
      section('Job boards in portals.yml', s.boards, [{ label: 'Board', key: 'id' }, { label: 'Provider', key: 'detail' }, { label: 'State', render: (r) => h('span', { class: `chip ${r.enabled ? 'ok' : ''}`, text: r.enabled ? 'enabled' : 'off' }) }]));
  });
}

async function viewNames(q) {
  const id = q.get('list') || 'telegram'; const text = q.get('q') || '';
  const body = h('div');
  const defs = [['telegram', 'Telegram'], ['funding', 'Funding'], ['directory', 'Directory'], ['campus', 'Campus watchlist']];
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'List' }, defs.map(([k, label]) => h('button', { type: 'button', 'aria-pressed': String(k === id), onclick: () => go('names', { list: k }), text: label })));
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Filter names', value: text, 'aria-label': 'Filter names', onkeydown: (e) => { if (e.key === 'Enter') go('names', { list: id, q: e.target.value }); } });
  main.replaceChildren(head('Names', 'Company names the feeders harvested. Discovery and the ATS probe read these files from data/ on their next run.'), h('div', { class: 'tools' }, seg, search), h('section', { class: 'panel flush' }, body));
  await load(body, () => api(`list/${id}?limit=600&q=${encodeURIComponent(text)}`), (l) => h('div', {},
    h('div', { class: 'panel-h' }, h('div', {}, h('strong', { class: 'ink', text: l.label }), ' ', h('span', { class: 'small', text: `${fmt(l.total)} in ${l.file}, updated ${ago(l.updated)}` })), runButton(id, 'Refresh from source')),
    table([{ label: '#', mono: true, render: (r) => r.i }, { label: id === 'campus' ? 'Page' : 'Company', render: (r) => (id === 'campus' ? linkTo(r.name) : r.name) }], l.shown.map((name, i) => ({ name, i: i + 1 })), { onEmpty: empty('This list is empty', 'Run its feeder to fill it.', runButton(id, 'Run the feeder')) }),
    l.total > l.shown.length ? h('div', { class: 'more', text: `Showing ${fmt(l.shown.length)} of ${fmt(l.total)}. Use the filter to narrow it.` }) : null));
}

async function viewBoards(q) {
  const kind = q.get('kind') || 'reviewed';
  const kinds = [['reviewed', 'Reviewed'], ['found', 'Found by probe'], ['verified', 'Directory verified'], ['rejected', 'Rejected']];
  const body = h('div');
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Boards' }, kinds.map(([k, label]) => h('button', { type: 'button', 'aria-pressed': String(k === kind), onclick: () => go('boards', { kind: k }), text: label })));
  main.replaceChildren(head('Boards', 'Indian ATS boards (Keka, Zoho Recruit, Darwinbox, Eightfold) with postings, and why others were left out.', runButton('boards-review', 'Review and add new boards')), h('div', { class: 'tools' }, seg), h('section', { class: 'panel flush' }, body));
  await load(body, () => api(`boards?kind=${kind}`), (rows) => {
    const cols = rows.length ? Object.keys(rows[0]).filter((k) => !['sample'].includes(k)).map((k) => ({ label: k.replace(/_/g, ' '), mono: ['jobs', 'india_jobs', 'india'].includes(k), render: (r) => (/^https?:/.test(r[k]) ? linkTo(r[k]) : r[k]) })) : [];
    return table(cols, rows, { onEmpty: empty('No boards in this list yet', 'The probe and review feeders fill it.') });
  });
}

async function viewCampus() {
  const body = h('div', { class: 'grid' });
  main.replaceChildren(head('Campus', 'Programme and hiring-drive pages watched for changes and for signals like batch-2027 or applications-open.', runButton('campus', 'Check pages now')), body);
  await load(body, () => api('campus'), (c) => h('div', { class: 'grid' },
    h('section', { class: 'panel flush' }, h('div', { class: 'panel-h' }, h('h2', { text: 'Recent changes' }), h('span', { class: 'small num', text: `${c.changes.length}` })),
      table([{ label: 'Date', mono: true, key: 'date' }, { label: 'Page', render: (r) => linkTo(r.url) }, { label: 'What', render: (r) => h('span', { class: `chip ${r.kind === 'new' ? 'live' : 'warn'}`, text: r.kind }) }, { label: 'Signals', key: 'signals' }, { label: 'Detail', key: 'detail' }], c.changes, { onEmpty: empty('No changes logged yet', 'The first check records a baseline; later checks log what moved.') })),
    h('section', { class: 'panel flush' }, h('div', { class: 'panel-h' }, h('h2', { text: 'Watched pages' }), h('span', { class: 'small num', text: `${c.pageCount}, ${c.failing} failing` })),
      table([{ label: 'Page', render: (r) => linkTo(r.url) }, { label: 'Signals', key: 'signals' }, { label: 'Last read', mono: true, key: 'lastOk' }, { label: 'Fails', mono: true, right: true, key: 'fails' }, { label: 'Last error', key: 'error' }], c.pages, { onEmpty: empty('No pages watched yet', 'Run the campus feeder.') }))));
}

async function viewRuns() {
  const body = h('div', { class: 'grid' });
  main.replaceChildren(head('Runs', 'What mine.py did, per source, and anything started from this page.'), body);
  await load(body, () => api('runs'), (r) => h('div', { class: 'grid' },
    r.started.length ? h('section', { class: 'panel flush' }, h('div', { class: 'panel-h' }, h('h2', { text: 'Started from this page' })),
      table([{ label: 'Started', mono: true, render: (x) => ago(x.at) }, { label: 'Target', key: 'target' }, { label: 'State', render: (x) => h('span', { class: `chip ${x.running ? 'live' : ''}`, text: x.running ? 'running' : 'done' }) }, { label: '', right: true, render: (x) => h('button', { class: 'btn small', type: 'button', onclick: () => openDrawer(x.id, x.target), text: 'Open log' }) }], r.started)) : null,
    h('section', { class: 'panel flush' }, h('div', { class: 'panel-h' }, h('h2', { text: 'Source runs' }), h('span', { class: 'small', text: r.logs.length ? `Latest log files: ${r.logs.slice(0, 3).join(', ')}` : '' })),
      table([{ label: 'Started', mono: true, render: (x) => ago(x.started) }, { label: 'Source', key: 'source' }, { label: 'Fetched', mono: true, right: true, key: 'fetched' }, { label: 'Kept', mono: true, right: true, key: 'kept' }, { label: 'New', mono: true, right: true, key: 'new' }, { label: 'Errors', mono: true, right: true, key: 'errors' }, { label: 'Health', render: (x) => h('span', { class: `chip ${/ok|healthy/i.test(x.health) ? 'ok' : x.health ? 'warn' : ''}`, text: x.health || '' }) }, { label: 'Dry run', render: (x) => (x.dry_run ? 'yes' : '') }], r.runs, { onEmpty: empty('No runs recorded', 'Runs are written to jobs.db by a real mine.py run; a dry run changes nothing.') }))));
}

const VIEWS = { overview: viewOverview, jobs: viewJobs, sources: viewSources, names: viewNames, boards: viewBoards, campus: viewCampus, runs: viewRuns };
function render() {
  const { name, q } = route();
  for (const a of tabsEl.children) { if (a.dataset.tab === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
  document.title = `${TABS.find(([id]) => id === name)[1]} - Pipeline`;
  VIEWS[name](q);
}
document.getElementById('refresh').addEventListener('click', render);
document.getElementById('launch').addEventListener('click', () => openLauncher());
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLauncher(); });
addEventListener('hashchange', render);
render();
