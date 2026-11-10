// One instance per frame. Scans the page, asks the background worker (which talks to the local server)
// for answers, fills what is known, and reports a summary for the side panel.
(() => {
  const AF = window.AF;
  if (!AF || AF.started) return;
  AF.started = true;

  // A call that never returns (the worker asleep, the server busy) must not freeze scanning, so every call has a time limit.
  const LIMITS = { draft: 300000, resume: 120000 };
  const bg = (type, payload = {}) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ error: 'the local server did not answer in time' }), LIMITS[type] || 45000);
      const done = (r) => { clearTimeout(timer); resolve(r); };
      try { chrome.runtime.sendMessage({ type, ...payload }, (res) => done(res || { error: chrome.runtime.lastError?.message || 'no reply' })); }
      catch (e) { done({ error: String(e) }); }
    });
  AF.bg = bg;

  const state = { mode: 'off', auto: true, warnings: [], items: new Map(), rules: null, neverRead: () => false, submitRe: null, signature: '', busy: false, again: false, diag: { v: chrome.runtime.getManifest().version } };

  const compile = (list) => new RegExp(list.map((p) => `(?:${p})`).join('|'), 'i');
  const text = (f) => [f.label, f.name, f.placeholder].filter(Boolean).join(' | ');

  function report() {
    const items = [...state.items.values()].map(({ id, label, type, status, value, source, reason, kind, hint, confidence, filled, options, note, required }) => ({ id, label, type, status, value, source, reason, kind, hint, confidence, filled, options, note }));
    const missing = [...state.items.values()].filter((i) => i.required && AF.isEmpty(i.id)).map((i) => ({ id: i.id, label: i.label }));
    syncChips();
    bg('frame-report', { url: location.href, host: location.hostname, mode: state.mode, items, missing, warnings: state.warnings, diag: state.diag });
  }

  async function fillItem(item, value = item.value, source = item.source || 'fact') {
    if (item.status === 'resume') {
      const ctx = AF.pageContext();
      const r = await bg('resume', { title: `${ctx.heading} ${ctx.title}`, jd_text: ctx.jd_text });
      if (r.error || !r.base64) { item.reason = r.error || 'No CV file found.'; return false; }
      const out = await AF.attachFile(item.id, r.name, r.base64);
      item.filled = out.ok; if (!out.ok) item.reason = out.reason;
      else { item.value = r.name; item.note = r.label; item.reason = ''; }
      return out.ok;
    }
    const out = await AF.fill(item.id, value, source, bg);
    item.filled = out.ok;
    if (out.ok) { item.value = value; item.source = source; } else item.reason = out.reason;
    return out.ok;
  }

  async function fillKnown() {
    for (const item of state.items.values()) {
      if (item.filled || (item.status !== 'fill' && item.status !== 'resume')) continue;
      try { await fillItem(item); } catch (e) { item.reason = String(e.message || e).slice(0, 100); }
      await AF.sleep(60);
    }
    report();
  }

  async function scan({ force = false } = {}) {
    if (state.mode === 'off') return;
    if (state.busy) { state.again = { force }; return; } // a change that arrives mid-scan is run right after, not dropped
    state.busy = true;
    try {
      const fields = AF.collect(state.neverRead);
      state.diag = { v: state.diag.v, inputs: document.querySelectorAll('input,select,textarea').length, readable: fields.length, url: location.pathname + location.search.slice(0, 60) };
      const nonPassword = fields.length;
      const hasResume = fields.some((f) => f.type === 'file' && /resume|cv/i.test(f.label));
      if (nonPassword < 3 && !hasResume) { state.items.clear(); report(); return; }
      const signature = fields.map((f) => f.id).join(',');
      if (!force && signature === state.signature) return;
      const previous = new Set(state.signature.split(',').filter(Boolean));
      const carried = fields.filter((f) => previous.has(f.id)).length;
      if (previous.size && carried < Math.ceil(previous.size / 2)) { flush('page-change'); last.fields = []; last.sentKey = ''; } // most fields are new: a different step or page
      state.signature = signature;
      const ctx = AF.pageContext();
      if (ctx.jd_text.length > 1200) bg('jd-cache', { key: ctx.jd_key, text: ctx.jd_text }); // Lever-style sites show the JD on another page than the form

      if (state.mode !== 'assist') { // watch mode only learns; nothing is suggested or filled
        state.items = new Map(fields.map((f) => [f.id, { ...f, status: 'watching' }]));
        report();
        announce();
        return;
      }
      const res = await bg('suggest', { url: location.href, title: document.title, fields });
      if (res.error) { state.items = new Map(fields.map((f) => [f.id, { ...f, status: 'offline', reason: res.error }])); report(); return; }
      if (res.mode && res.mode !== 'assist') { state.mode = res.mode; }
      const next = new Map();
      for (const f of fields) {
        const r = res.results.find((x) => x.id === f.id) || { status: 'unknown' };
        const prev = state.items.get(f.id);
        next.set(f.id, { ...f, ...r, filled: prev?.filled && prev.value === r.value ? true : false, value: r.value ?? '' , current: f.value });
      }
      state.items = next;
      state.warnings = res.warnings || [];
      announce(); // before filling: one field that fails to fill must never stop the panel from appearing
      if (state.auto) await fillKnown(); else report();
      predraft();
    } catch (e) {
      state.diag = { ...state.diag, error: String(e.message || e).slice(0, 120) }; report();
    } finally {
      state.busy = false;
      if (state.again) { const a = state.again; state.again = false; setTimeout(() => scan(a), 200); }
    }
  }

  async function draft(id) {
    const item = state.items.get(id);
    if (!item) return;
    item.status = 'drafting'; report();
    const field = { id, label: item.label, type: item.type, options: item.options, maxlength: item.maxlength, name: item.name, placeholder: item.placeholder };
    const res = await bg('draft', { field, ctx: AF.pageContext(), url: location.href });
    if (res.error) { item.status = 'draftable'; item.reason = res.error; }
    else Object.assign(item, { status: res.status, value: res.value ?? '', source: res.source || item.source, reason: res.reason, confidence: res.confidence });
    report();
    const box = AF.handles.get(id)?.els[0];
    if (box && document.activeElement === box && AF.isEmpty(id)) showSuggestion(item); // you are already in the box: show it now
  }

  // ---- tell the person a job or form was found ----
  // The panel opens itself inside the page once per page load (a setting in the panel's footer can turn that off); closing it
  // leaves a small button to bring it back, and that button can be hidden for this tab.
  const stored = (key) => new Promise((r) => { try { chrome.storage.local.get(key, (v) => r(v?.[key])); } catch { r(undefined); } });
  async function announce() {
    if (window !== window.top || AF.dockOpen() || AF.launcherShown() || state.announced || state.items.size < 3) return;
    state.announced = true;
    let hidden = false;
    try { hidden = sessionStorage.getItem('af-pill-hidden') === '1'; } catch { /* storage blocked: show it */ }
    if (hidden) return;
    const showPill = () => AF.launcher({
      text: 'Form found. Open Apply',
      onOpen: () => AF.dock({ onClose: showPill }),
      onDismiss: () => { try { sessionStorage.setItem('af-pill-hidden', '1'); } catch { /* shown again on the next page */ } }, // this tab only, never the whole site
    });
    const settings = (await stored('settings')) || {};
    if (settings.autoOpen === false) showPill(); else AF.dock({ onClose: showPill });
  }

  // ---- chips beside the questions ----
  function syncChips() {
    const live = new Set();
    if (state.mode === 'assist') {
      for (const it of state.items.values()) {
        const anchor = AF.handles.get(it.id)?.els[0];
        if (!anchor || it.kind === 'option' || dismissed.has(it.id) || it.filled || !AF.isEmpty(it.id)) continue;
        const open = () => showSuggestion(it);
        if (it.status === 'draftable') AF.chip(it.id, anchor, { text: 'Suggest answer', tone: 'idle', onClick: async () => { await draft(it.id); showSuggestion(it); } });
        else if (it.status === 'drafting') AF.chip(it.id, anchor, { text: 'Writing from your CV...', tone: 'idle' });
        else if (it.status === 'draft' && it.value) AF.chip(it.id, anchor, { text: 'Suggestion ready', tone: 'ready', onClick: open });
        else if (['text', 'textarea'].includes(it.type) && ['unknown', 'offline'].includes(it.status)) {
          // never silent: say why there is no suggestion, and let it be tried again
          const why = it.status === 'offline' ? 'Server not reachable' : (it.reason || 'The CV does not answer this');
          AF.chip(it.id, anchor, { text: `No suggestion: ${why.slice(0, 48)}. Try again`, tone: 'idle', onClick: async () => { await draft(it.id); showSuggestion(it); } });
        } else continue;
        live.add(it.id);
      }
    }
    AF.keepChips(live);
  }

  // ---- suggestions you approve ----
  // Fields nothing could fill are drafted in the background, a few at a time, so the answer is ready when you reach the box.
  // Nothing is written to the page until you press Use in the card.
  const dismissed = new Set();
  let predrafting = false;
  async function predraft() {
    if (predrafting || state.mode !== 'assist') return;
    predrafting = true;
    try {
      let n = 0;
      for (const it of [...state.items.values()]) {
        if (n >= 6) break;
        if (it.status !== 'draftable' || it.kind === 'option' || dismissed.has(it.id) || !AF.isEmpty(it.id)) continue;
        n++; await draft(it.id);
      }
    } finally { predrafting = false; }
  }

  function itemForElement(target) {
    for (const it of state.items.values()) if (AF.handles.get(it.id)?.els.some((e) => e === target || e.contains?.(target))) return it;
    return null;
  }

  function showSuggestion(it) {
    const anchor = AF.handles.get(it.id)?.els[0];
    if (!anchor || dismissed.has(it.id)) return;
    const actions = {
      use: async (text) => { await fillItem(it, text, 'draft'); it.status = 'draft'; it.value = text; report(); },
      draft: async () => { AF.suggestCard(anchor, { state: 'drafting' }, actions); await draft(it.id); showSuggestion(it); },
      dismiss: () => dismissed.add(it.id),
    };
    if (it.status === 'drafting') return AF.suggestCard(anchor, { state: 'drafting' }, actions);
    if (it.status === 'draft' && it.value && !it.filled) return AF.suggestCard(anchor, { state: 'ready', text: it.value }, actions);
    if (it.status === 'draftable') return AF.suggestCard(anchor, { state: 'offer', note: it.reason && it.reason !== 'no saved answer' ? `Last try: ${it.reason}` : '' }, actions);
    if (it.status === 'unknown') return AF.suggestCard(anchor, { state: 'none', note: it.reason }, actions);
  }

  document.addEventListener('focusin', (e) => {
    if (state.mode !== 'assist' || !(e.target instanceof Element) || e.target.closest('.af-card')) return;
    const it = itemForElement(e.target);
    if (it && AF.isEmpty(it.id) && it.kind !== 'option') showSuggestion(it); else if (!e.target.closest('.af-card')) AF.closeSuggest?.();
  }, true);

  // ---- learning your answers ----
  // The last readable copy of the current page's answers. A page can vanish the moment you press something, so the copy is
  // refreshed as you type and on every click, and sent when the page changes, you press Next/Submit, or you leave.
  const last = { fields: [], url: '', sentKey: '' };

  function remember() {
    if (state.mode === 'off' || state.items.size < 3) return;
    const fields = AF.snapshot(state.neverRead);
    if (fields.length) { last.fields = fields; last.url = location.href; }
  }

  function flush(why) {
    if (!last.fields.length) return;
    const key = JSON.stringify(last.fields.map((f) => [f.label, f.value]));
    if (key === last.sentKey) return; // already sent; the server also ignores repeats
    last.sentKey = key;
    const ctx = AF.pageContext();
    bg('capture', { url: last.url || location.href, title: ctx.title, company: ctx.company, fields: last.fields, why, at: new Date().toISOString() });
  }

  function onCapture(why) {
    if (state.mode === 'off') return;
    remember();
    flush(why);
    AF.flagMissing(); report(); // empty required fields are outlined on the page and listed in the panel; the click is never blocked
  }

  let rememberTimer;
  const rememberSoon = () => { clearTimeout(rememberTimer); rememberTimer = setTimeout(remember, 500); };

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    const run = async () => {
      if (msg.type === 'rescan') { state.signature = ''; await scan({ force: true }); }
      else if (msg.type === 'fill-known') await fillKnown();
      else if (msg.type === 'fill-one') { const it = state.items.get(msg.id); if (it) { await fillItem(it, msg.value, msg.source || 'draft'); report(); } }
      else if (msg.type === 'draft') await draft(msg.id);
      else if (msg.type === 'draft-all') { for (const it of [...state.items.values()]) if (it.status === 'draftable') await draft(it.id); }
      else if (msg.type === 'attach') { const out = await AF.attachFile(msg.id, msg.name, msg.base64, true); const it = state.items.get(msg.id); if (it && out.ok) { it.filled = true; it.value = msg.name; } report(); return reply(out); }
      else if (msg.type === 'context') return reply({ ok: true, ctx: AF.pageContext() });
      else if (msg.type === 'focus') {
        const el = AF.handles.get(msg.id)?.els[0];
        if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.focus?.({ preventScroll: true }); }
      } else if (msg.type === 'set-mode') { state.mode = msg.mode; state.auto = msg.auto ?? state.auto; state.signature = ''; await scan({ force: true }); }
      reply({ ok: true });
    };
    run();
    return true;
  });

  const hostMatches = (host, site) => host === site || host.endsWith(`.${site}`);

  // Pages outside the site list count as an application only when the address reads like one. Single-page sites (Phenom,
  // Workday and others) change the address after load, so the check repeats for a while instead of running once.
  function applicable(rules) {
    const host = location.hostname;
    const g = rules.generic || {};
    const listed = [...rules.ats_sites.map((x) => x.split('/')[0]), ...Object.keys(rules.guarded_sites || {})].some((site) => hostMatches(host, site));
    if (listed) return true;
    if (!g.enabled || (g.never_hosts || []).some((site) => hostMatches(host, site))) return false;
    if (new RegExp(g.url_hints, 'i').test(location.pathname + location.hash)) return true; // the path only: a query like ?q=jobs must not count
    return looksLikeApplication(g, rules);
  }

  // Whatever the address or the buttons say: a page is an application when several fields are readable and enough of them ask
  // application questions (resume, job title, education, notice period, ...). Search boxes and logins never reach the count.
  function looksLikeApplication(g, rules) {
    if (!g.field_cues || document.querySelectorAll('input,select,textarea').length < (g.min_fields || 3)) return false;
    const never = compile(rules.never_read);
    const fields = AF.collect((f) => f.type === 'password' || never.test(text(f)));
    if (fields.length < (g.min_fields || 3)) return false;
    const cue = new RegExp(g.field_cues, 'i');
    return fields.filter((f) => cue.test(`${f.label} ${f.name}`)).length >= (g.min_cue_fields || 2);
  }

  async function start(hello) {
    if (state.started) return;
    state.started = true;
    state.mode = hello.mode;
    if (state.mode === 'off') return;
    AF.watchSubmit({ submitRe: state.submitRe, onCapture });
    document.addEventListener('input', (e) => { if (e.isTrusted) rememberSoon(); }, true);
    document.addEventListener('change', (e) => { if (e.isTrusted) rememberSoon(); }, true);
    document.addEventListener('click', (e) => { if (e.isTrusted && e.target.closest?.('button,[role=button],a,input[type=submit],input[type=button]')) remember(); }, true);
    window.addEventListener('pagehide', () => flush('leave'));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush('hidden'); });
    window.addEventListener('popstate', () => { remember(); flush('route'); });
    window.addEventListener('hashchange', () => { remember(); flush('route'); });
    await scan();
    let timer;
    new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => scan(), 900); })
      .observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'style', 'class', 'aria-hidden', 'open'] });
  }

  // The page's own text for private-field rules and button words comes from the server's rules.json (cached by the worker).
  async function init() {
    const hello = await bg('hello', { host: location.hostname, url: location.href });
    if (hello.error || !hello.rules) return;
    state.rules = hello.rules;
    state.auto = hello.auto;
    const never = compile(hello.rules.never_read);
    state.neverRead = (f) => f.type === 'password' || never.test(text(f));
    state.submitRe = new RegExp(hello.rules.submit_text, 'i');
    if (hello.mode === 'off') return;

    if (applicable(hello.rules)) return start(hello);
    // Not an application page yet. Look again while the page is open and visible, for a few minutes.
    const until = Date.now() + (hello.rules.generic?.poll_minutes || 15) * 60000;
    const poll = setInterval(() => {
      if (Date.now() > until) return clearInterval(poll);
      if (document.visibilityState === 'visible' && applicable(hello.rules)) { clearInterval(poll); start(hello); }
    }, 2000);
  }

  init();
})();
