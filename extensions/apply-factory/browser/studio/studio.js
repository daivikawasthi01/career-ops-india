// CV studio: edit a CV as tex with a live preview, turn a PDF into tex, tailor a CV to a job. Everything compiles on the local server.
const params = new URLSearchParams(location.hash.slice(1));
const tabId = Number(params.get('tab')) || null;
const viewEl = document.getElementById('view');
const tabsEl = document.getElementById('tabs');
const slotEl = document.getElementById('slot');
const statusEl = document.getElementById('status');

const api = (path, body) => chrome.runtime.sendMessage({ type: 'api', path, body: body || {} });
const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, tabId, ...extra });

// Import, tailor and fix take minutes with a local model: start the job, then poll it.
async function longApi(path, body) {
  const started = await api(path, body);
  if (started.error || !started.job) return started;
  const until = Date.now() + 20 * 60 * 1000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2000));
    const j = await api('/cv/job', { id: started.job });
    if (j.error) return j;
    if (j.status === 'done') return j.result;
    if (j.status === 'error') return { error: j.error };
  }
  return { error: 'Timed out waiting for the local model.' };
}

const S = { view: params.get('view') || 'edit', slot: 'default', slots: [], tex: '', meta: {}, errors: [], pages: [],
  imp: null, tailor: null, jd: { company: '', title: '', text: '' } };
let compileTimer = null;
let editor = null;

const say = (text, tone = '') => { statusEl.textContent = text; statusEl.className = `note ${tone}`; };
const pages = (list, label) => h('div', { class: 'pages' }, list.map((b, i) => h('img', { src: `data:image/png;base64,${b}`, alt: `${label}, page ${i + 1}` })));
const slotLabel = () => S.slots.find((s) => s.kind === S.slot)?.label || 'Default CV';

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function download(name, base64) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const a = h('a', { href: URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })), download: name });
  document.body.append(a); a.click(); a.remove();
}

// ---- slots and tabs ----
async function loadSlots() {
  const res = await api('/cv/slots');
  if (res.error) { say(res.error, 'warn'); return; }
  S.slots = res.slots;
  slotEl.replaceChildren(...S.slots.map((s) => h('option', { value: s.kind, selected: s.kind === S.slot, text: `${s.label}${s.tex ? '' : ' (no tex yet)'}` })));
}

function drawTabs() {
  tabsEl.replaceChildren(h('div', { class: 'groove' }, [['edit', 'Edit'], ['import', 'Import PDF'], ['tailor', 'Tailor']].map(([id, name]) =>
    h('button', { role: 'tab', 'aria-selected': String(S.view === id), text: name, onclick: () => go(id) }))));
}

function go(view) { S.view = view; drawTabs(); draw(); }

slotEl.addEventListener('change', async () => { S.slot = slotEl.value; await loadTex(); draw(); });

// ---- edit ----
async function loadTex() {
  const res = await api('/cv/tex', { kind: S.slot });
  S.tex = res.tex || '';
  S.meta = res.meta || {};
  S.errors = []; S.pages = [];
  if (S.tex) await compileNow();
}

async function compileNow() {
  say('Compiling');
  const res = await api('/cv/compile', { tex: S.tex });
  if (res.error) { say(res.error, 'warn'); return; }
  S.errors = res.errors; S.pages = res.pages;
  say(res.ok ? 'Compiled' : `${res.errors.length} error${res.errors.length === 1 ? '' : 's'}`, res.ok ? 'ok' : 'warn');
  drawPreview();
}

function drawPreview() {
  const box = document.getElementById('preview');
  if (!box) return;
  fill(box, 
    S.errors.length ? h('ul', { class: 'errors' }, S.errors.map((e) => h('li', {}, h('button', { text: e.line ? `Line ${e.line}: ${e.msg}` : e.msg, onclick: () => jumpTo(e.line) })))) : null,
    S.pages.length ? pages(S.pages, 'Compiled CV') : h('p', { class: 'empty', text: 'The compiled CV appears here.' }));
}

function jumpTo(line) {
  if (!line || !editor) return;
  const at = S.tex.split('\n').slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0);
  editor.focus();
  editor.setSelectionRange(at, at + (S.tex.split('\n')[line - 1] || '').length);
}

async function publish() {
  if (!S.tex.trim()) return;
  say('Compiling and publishing');
  const res = await api('/cv/publish', { kind: S.slot, tex: S.tex });
  if (res.error) { say(res.error, 'warn'); return; }
  S.errors = res.errors; if (res.pages?.length) S.pages = res.pages;
  if (res.published) { S.meta = { confirmed: true, source: 'manual' }; say(`Published. Forms now attach this as the ${slotLabel()}.`, 'ok'); await loadSlots(); }
  else say('Not published: fix the errors first. Your current PDF is unchanged.', 'warn');
  draw();
}

async function fixWithAi() {
  say('Asking the local model to fix the tex. This can take a minute.');
  const res = await longApi('/cv/fix', { tex: S.tex });
  if (res.error) { say(res.error, 'warn'); return; }
  S.tex = res.tex; S.errors = res.errors; S.pages = res.pages;
  say(res.ok ? `Fixed in ${res.rounds} round${res.rounds === 1 ? '' : 's'}. Check the wording before you publish.` : 'Could not fix it automatically.', res.ok ? 'ok' : 'warn');
  draw();
}

function drawEdit() {
  const imported = S.meta.confirmed === false && S.meta.source === 'import';
  editor = h('textarea', { class: 'tex', spellcheck: 'false', 'aria-label': 'CV tex source', oninput: (e) => {
    S.tex = e.target.value; clearTimeout(compileTimer); compileTimer = setTimeout(compileNow, 1000);
  } }, S.tex);
  fill(viewEl, 
    imported && h('section', { class: 'stock' },
      h('h2', { text: 'Imported from a PDF: check it before you publish' }),
      h('p', { class: 'note', text: 'The local model read your PDF and a template wrote this tex. Compare the preview with your original, fix anything wrong, then publish.' })),
    h('div', { class: 'split' },
      h('section', { class: 'stock' },
        h('h2', { text: 'Tex source' }),
        S.tex || S.meta.source ? null : h('p', { class: 'note', text: 'No tex for this CV yet. Paste yours here, or use Import PDF. To allow tailoring, wrap the summary and skills text in "% AF:BEGIN summary" ... "% AF:END summary" and the same for skills.' }),
        editor,
        h('div', { class: 'row' },
          h('button', { class: 'btn btn--card', text: 'Compile now', onclick: compileNow }),
          h('button', { class: 'btn btn--card', text: 'Fix with AI', disabled: !S.errors.length, onclick: fixWithAi }),
          h('button', { class: 'btn btn--card', text: 'Save draft', onclick: async () => { await api('/cv/save', { kind: S.slot, tex: S.tex }); say('Draft saved', 'ok'); await loadSlots(); } }),
          h('button', { class: 'btn btn--ink', text: `Publish as ${slotLabel()}`, disabled: !S.tex.trim(), onclick: publish }))),
      h('section', { class: 'stock', id: 'preview', 'aria-label': 'Preview' })));
  drawPreview();
}

// ---- import ----
async function runImport(file) {
  if (!file) return;
  if (S.slots.find((s) => s.kind === S.slot)?.tex && !confirm(`This replaces the tex for the ${slotLabel()}. The old tex is kept as a .previous file. Continue?`)) return;
  S.imp = { busy: true };
  draw();
  say('The local model is reading your PDF. This can take a minute or two.');
  const res = await longApi('/cv/import', { base64: await toBase64(file), kind: S.slot });
  S.imp = res.error ? { error: res.error } : res;
  say(res.error ? 'Import failed' : 'Imported. Check it, then open it in the editor.', res.error ? 'warn' : 'ok');
  await loadSlots();
  draw();
}

function drawImport() {
  const imp = S.imp;
  const input = h('input', { type: 'file', accept: 'application/pdf', class: 'visually-hidden', 'aria-label': 'Choose a CV PDF', onchange: (e) => runImport(e.target.files[0]) });
  fill(viewEl, 
    h('section', { class: 'stock' },
      h('h2', { text: `Turn a PDF into tex for the ${slotLabel()}` }),
      h('p', { class: 'note', text: 'The local model reads the text of your PDF, a template writes the tex, tectonic compiles it, and the model fixes compile errors. Nothing replaces your CV until you publish from the editor.' }),
      h('div', { class: 'row' }, input, h('button', { class: 'btn btn--ink', text: imp?.busy ? 'Working' : 'Choose a PDF', disabled: !!imp?.busy, onclick: () => input.click() }))),
    imp?.error && h('section', { class: 'stock' }, h('p', { class: 'warn', text: imp.error })),
    imp?.tex && h('div', { class: 'split' },
      h('section', { class: 'stock' }, h('h2', { text: 'Your original' }), pages(imp.original_pages, 'Original CV')),
      h('section', { class: 'stock' }, h('h2', { text: 'Compiled from the tex' }), pages(imp.pages, 'Imported CV'))),
    imp?.tex && h('section', { class: 'stock' },
      h('h2', { text: imp.unverified.length ? `${imp.unverified.length} piece${imp.unverified.length === 1 ? '' : 's'} of text not found in your PDF` : 'Every piece of text was found in your PDF' }),
      imp.unverified.length ? h('ul', { class: 'errors' }, imp.unverified.map((u) => h('li', { class: 'warn', text: u }))) : null,
      !imp.compile.ok && h('p', { class: 'warn', text: `It still does not compile: ${imp.compile.errors.map((e) => e.msg).join('; ')}` }),
      imp.fix_rounds ? h('p', { class: 'note', text: `The model fixed compile errors in ${imp.fix_rounds} round${imp.fix_rounds === 1 ? '' : 's'}.` }) : null,
      h('div', { class: 'row' }, h('button', { class: 'btn btn--ink', text: 'Open in the editor', onclick: async () => { await loadTex(); go('edit'); } }))));
}

// ---- tailor ----
async function runTailor() {
  S.tailor = { busy: true };
  draw();
  say('Tailoring with the local model. This can take a minute.');
  const res = await longApi('/cv/tailor', { kind: S.slot, jd_text: S.jd.text, title: S.jd.title, company: S.jd.company });
  S.tailor = res.error ? { error: res.error } : res;
  say(res.error ? 'Could not tailor' : 'Tailored. Review the changes below.', res.error ? 'warn' : 'ok');
  draw();
}

async function saveTailored() {
  const t = S.tailor;
  const res = await api('/cv/tailor/save', { kind: S.slot, tex: t.tex_after, jd_text: S.jd.text, title: S.jd.title, company: S.jd.company });
  if (res.error || !res.ok) { say(res.error || 'It did not compile', 'warn'); return null; }
  return res;
}

function diffBlock(lines) {
  const body = lines.filter((l) => !l.startsWith('---') && !l.startsWith('+++'));
  if (!body.length) return h('p', { class: 'note', text: 'No changes: the CV already matches this job as far as the rules allow.' });
  return h('pre', { class: 'diff' }, body.map((l) => h('span', { class: l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'ctx', text: l || ' ' })));
}

function drawTailor() {
  const t = S.tailor;
  const jd = S.jd;
  const tailorBtn = h('button', { class: 'btn btn--ink', text: t?.busy ? 'Working' : 'Tailor my CV', disabled: !!t?.busy || jd.text.trim().length < 200, onclick: runTailor });
  const sync = () => { tailorBtn.disabled = !!t?.busy || jd.text.trim().length < 200; };
  fill(viewEl, 
    h('section', { class: 'stock' },
      h('h2', { text: `Tailor the ${slotLabel()} to a job` }),
      h('div', { class: 'fields' },
        h('label', {}, 'Company', h('input', { class: 'field-input', value: jd.company, oninput: (e) => { jd.company = e.target.value; } })),
        h('label', {}, 'Role', h('input', { class: 'field-input', value: jd.title, oninput: (e) => { jd.title = e.target.value; } }))),
      h('label', { class: 'note' }, 'Job description', h('textarea', { class: 'jd', 'aria-label': 'Job description', oninput: (e) => { jd.text = e.target.value; sync(); } }, jd.text)),
      h('p', { class: 'note', text: 'Only the summary and skills are rewritten, and only with words your CV already supports. Anything else is refused and listed.' }),
      h('div', { class: 'row' }, tailorBtn, jd.text.trim().length < 200 ? h('span', { class: 'note', text: 'Paste at least a few sentences of the job description.' }) : null)),
    t?.error && h('section', { class: 'stock' }, h('p', { class: 'warn', text: t.error })),
    t?.tex_after && tailorResult(t));
}

function tailorResult(t) {
  const regions = Object.entries(t.regions);
  return h('div', { class: 'view' },
    t.similar && h('section', { class: 'stock' },
      h('h2', { text: `Very close to the CV you made for ${t.similar.company || 'an earlier job'}` }),
      h('p', { class: 'note', text: `career-ops rates the two job descriptions as ${Math.round(t.similar.score * 100)}% alike, so that CV can be reused instead.` }),
      h('div', { class: 'row' }, h('button', { class: 'btn btn--card', text: 'Download that CV', onclick: async () => { const r = await api('/cv/tailored/get', { folder: t.similar.folder }); if (r.error) say(r.error, 'warn'); else download(r.name, r.base64); } }))),
    h('div', { class: 'split' },
      h('section', { class: 'stock' },
        h('h2', { text: 'What changed' }),
        t.matched.length ? h('ul', { class: 'chips', 'aria-label': 'Job keywords your CV already covers' }, t.matched.map((k) => h('li', { text: k }))) : null,
        regions.map(([name, r]) => h('p', { class: r.skipped ? 'warn' : 'note',
          text: r.skipped ? `The ${name} was kept as it was. The rewrite used words your CV does not support: ${r.flagged.join(', ') || 'none named'}.` : r.changed ? `The ${name} was reworded for this job.` : `The ${name} already fits.` })),
        diffBlock(t.diff)),
      h('section', { class: 'stock' }, h('h2', { text: 'Preview' }),
        t.ok ? pages(t.pages, 'Tailored CV') : h('p', { class: 'warn', text: `It does not compile: ${t.errors.map((e) => e.msg).join('; ')}` }))),
    h('section', { class: 'stock' },
      h('div', { class: 'row' },
        h('button', { class: 'btn btn--ink', text: 'Download PDF', disabled: !t.ok, onclick: async () => { const r = await saveTailored(); if (r) { download(r.name, r.base64); say(`Saved ${r.name}`, 'ok'); } } }),
        h('button', { class: 'btn btn--card', text: 'Attach to the open form', disabled: !t.ok || !tabId, onclick: async () => {
          const r = await saveTailored();
          if (!r) return;
          const out = await send('attach-file', { kind: 'resume', name: r.name, base64: r.base64 });
          say(out?.error ? out.error : `Attached ${r.name} to the form.`, out?.error ? 'warn' : 'ok');
        } }),
        h('button', { class: 'btn btn--card', text: 'Edit this tex', onclick: () => { S.tex = t.tex_after; S.meta = {}; S.errors = []; S.pages = t.pages; go('edit'); compileNow(); } }))));
}

function draw() {
  if (S.view === 'import') drawImport();
  else if (S.view === 'tailor') drawTailor();
  else drawEdit();
}

(async function start() {
  drawTabs();
  await loadSlots();
  if (tabId) {
    const ctx = await send('job-context');
    if (ctx && !ctx.error) S.jd = { company: ctx.company || '', title: ctx.heading || ctx.title || '', text: ctx.jd_text || '' };
  }
  await loadTex();
  draw();
})();

// Theme toggle: dark by default, the label says what the button will switch to.
(() => {
  const btn = document.getElementById('theme');
  if (!btn) return;
  const label = () => { btn.textContent = window.AFTheme.current() === 'dark' ? 'Light theme' : 'Dark theme'; };
  btn.addEventListener('click', () => { window.AFTheme.toggle(); label(); });
  label();
})();
