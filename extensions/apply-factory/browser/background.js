// Service worker. The only part that talks to the local server (content scripts cannot reach http://127.0.0.1
// from an https page). Also keeps per-tab state for the side panel and the per-site mode overrides.
const SERVER = 'http://127.0.0.1:8765'; // config.yaml server.port; tests/test_extension.py checks they agree
const MODES = ['off', 'watch', 'assist'];

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ---- storage helpers (every call wrapped: a locked-down profile must not break fill) ----
const local = {
  get: async (k, d) => { try { return (await chrome.storage.local.get(k))[k] ?? d; } catch { return d; } },
  set: async (k, v) => { try { await chrome.storage.local.set({ [k]: v }); } catch {} },
};
const session = {
  get: async (k, d) => { try { return (await chrome.storage.session.get(k))[k] ?? d; } catch { return d; } },
  set: async (k, v) => { try { await chrome.storage.session.set({ [k]: v }); } catch {} },
  remove: async (k) => { try { await chrome.storage.session.remove(k); } catch {} },
};

// ---- server calls ----
// Many frames and the panel can ask at the same moment on first run. Only one pairing request may be in flight: a second one would be refused
// ("already paired") and surface as a false error.
let pairing = null;
async function ensureToken(force = false) {
  let token = force ? null : await local.get('token', null);
  if (token) return token;
  if (!pairing) {
    pairing = (async () => {
      const res = await fetch(`${SERVER}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(res.status === 403 ? 'This server is already linked to another Chrome profile. To use this one instead, stop the server and start it again with --reset-pair.' : `pair failed (${res.status})`);
      const t = (await res.json()).token;
      await local.set('token', t);
      return t;
    })().finally(() => { pairing = null; });
  }
  return pairing;
}

// How long a call may take before the panel is told the server did not answer. Model calls and CV jobs are slow; everything else is not.
const SLOW = /^\/(setup\/(suggest_roles|key|cv)|draft|draft_batch|cover|cover\/pdf|resume|resume\/upload|cv\/|company\/|mail\/|outreach\/|gmail\/|score|suggest|pick|capture|preflight|applied|queue|retry)/;
const timeoutFor = (path) => (SLOW.test(path) ? 300000 : 60000);

async function api(path, body) {
  const call = async (token) => fetch(`${SERVER}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutFor(path)),
  });
  let res;
  try {
    res = await call(await ensureToken());
    if (res.status === 401) res = await call(await ensureToken(true));
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new Error('the local server did not answer in time');
    throw e instanceof TypeError ? new Error('server offline') : e; // a refused pairing keeps its own message
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || data.error || `server ${res.status}`);
  return data;
}

// ---- rules (cached so the page still behaves if the server is briefly down) ----
// Every frame of every page asks for the rules when it loads, so a fresh copy is reused for a minute instead of hitting the server each time.
let rulesMemo = { at: 0, value: null, inflight: null };
async function getRules() {
  if (rulesMemo.value && Date.now() - rulesMemo.at < 60000) return rulesMemo.value;
  if (!rulesMemo.inflight) {
    rulesMemo.inflight = (async () => {
      try { const r = await api('/rules'); await local.set('rules', r); rulesMemo.value = r; rulesMemo.at = Date.now(); return r; }
      catch { return local.get('rules', null); }
    })().finally(() => { rulesMemo.inflight = null; });
  }
  return rulesMemo.inflight;
}

// ---- site modes ----
const hostMatches = (host, site) => host === site || host.endsWith(`.${site}`);
function defaultMode(rules, host) {
  for (const [site, mode] of Object.entries(rules.guarded_sites || {})) if (hostMatches(host, site)) return mode;
  return 'assist';
}
async function modeFor(rules, host) {
  const overrides = await local.get('siteModes', {});
  const m = overrides[host];
  return MODES.includes(m) ? m : defaultMode(rules, host);
}

// ---- per-tab state for the panel ----
const stateKey = (tabId) => `tab:${tabId}`;
// Frames of one tab report at the same time. Each report is a read-modify-write of the tab's whole state, so they run one after another per tab;
// otherwise the last writer silently drops the other frames' items.
const tabQueues = new Map();
const serial = (tabId, fn) => {
  const run = (tabQueues.get(tabId) || Promise.resolve()).catch(() => {}).then(fn);
  tabQueues.set(tabId, run);
  run.finally(() => { if (tabQueues.get(tabId) === run) tabQueues.delete(tabId); }).catch(() => {});
  return run;
};

const saveFrame = (tabId, frameId, report) => serial(tabId, () => saveFrameNow(tabId, frameId, report));
async function saveFrameNow(tabId, frameId, report) {
  const st = await session.get(stateKey(tabId), { frames: {} });
  st.frames[frameId] = { ...report, at: Date.now() };
  await session.set(stateKey(tabId), st);
  const count = Object.values(st.frames).flatMap((f) => f.items || []).filter((i) => i.status === 'fill' || i.status === 'resume').filter((i) => !i.filled).length;
  chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#d4604a' }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'state-changed', tabId }).catch(() => {});
}

async function toFrames(tabId, msg) {
  const st = await session.get(stateKey(tabId), { frames: {} });
  const ids = new Set(Object.keys(st.frames).map(Number));
  // A page that was Off from the start never reported, so it is not in the state; its frames are found from the tab itself. Without this a mode
  // change from the panel never reached it, and a site could not be turned on until the tab was reloaded.
  const live = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
  for (const f of live || []) ids.add(f.frameId);
  await Promise.all([...ids].map((frameId) => chrome.tabs.sendMessage(tabId, msg, { frameId }).catch(() => {})));
}

async function toOwner(tabId, itemId, msg) {
  const st = await session.get(stateKey(tabId), { frames: {} });
  for (const [frameId, f] of Object.entries(st.frames)) {
    if ((f.items || []).some((i) => i.id === itemId)) return chrome.tabs.sendMessage(tabId, msg, { frameId: Number(frameId) }).catch(() => {});
  }
}

// ---- content-script messages ----
const handlers = {
  async hello({ host }) {
    const rules = await getRules();
    if (!rules) return { error: 'server offline' };
    const settings = await local.get('settings', { auto: true });
    return { rules, mode: await modeFor(rules, host), auto: settings.auto !== false };
  },
  suggest: ({ url, title, fields }) => api('/suggest', { url, title, fields }),
  async 'draft-batch'({ fields, ctx, url, fresh }) {
    if ((ctx.jd_text || '').length < 800) {
      const cached = await session.get(`jd:${ctx.jd_key}`, '');
      if (cached) ctx = { ...ctx, jd_text: cached };
    }
    return api('/draft_batch', { fields, ctx, url, fresh });
  },
  async draft({ field, ctx, url, fresh }, sender) {
    if ((ctx.jd_text || '').length < 800) {
      const cached = await session.get(`jd:${ctx.jd_key}`, '');
      if (cached) ctx = { ...ctx, jd_text: cached };
    }
    return api("/draft", { field, ctx, url, fresh });
  },
  pick: async ({ answer, options }) => { const r = await api('/pick', { answer, options }); return { option: r.option, queries: r.queries }; },
  resume: ({ title, jd_text }) => api('/resume', { title, jd_text }),
  capture: (body) => api('/capture', body),
  event: ({ kind, n }) => api('/event', { kind, n }).catch(() => ({ ok: false })),   // usage totals are best effort
  async submitted({ url, title, company }, sender) {   // survives the navigation a submit causes, which wipes the tab's form state
    await session.set(`sub:${sender.tab.id}`, { url, title, company, at: Date.now() });
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: '?' }).catch(() => {});
    chrome.runtime.sendMessage({ type: 'state-changed', tabId: sender.tab.id }).catch(() => {});
    return { ok: true };
  },
  async 'side-panel-open'(_msg, sender) { return { open: sidePanelWindows.has(sender.tab?.windowId) }; },
  async 'jd-cache'({ key, text }) { await session.set(`jd:${key}`, text); return { ok: true }; },
  async 'frame-report'(msg, sender) { await saveFrame(sender.tab.id, sender.frameId, msg); return { ok: true }; },
};

// ---- panel messages ----
// A lookup that outlives the panel: the server keeps running it, and when it ends with the panel closed the toolbar icon shows a green badge.
const watching = new Map();
async function watchJob(id, company) {
  if (watching.has(id)) return;
  watching.set(id, company);
  for (let i = 0; i < 400; i++) {   // about 25 minutes at most
    await new Promise((r) => setTimeout(r, 4000));
    const j = await api('/cv/job', { id }).catch(() => null);
    if (j && j.status !== 'running') {
      watching.delete(id);
      const open = sidePanelWindows.size > 0;
      if (!open) { chrome.action.setBadgeBackgroundColor({ color: '#16a34a' }); chrome.action.setBadgeText({ text: '✓' }); chrome.action.setTitle({ title: `${company}: research is ready. Open the panel, Company tab.` }); }
      return;
    }
  }
  watching.delete(id);
}

const panel = {
  'watch-job'({ id, company }) { watchJob(id, String(company || 'Company')); return { ok: true }; },
  async 'clear-badge'() {   // the panel opened: a finished lookup is waiting if the badge was up
    const had = !!(await chrome.action.getBadgeText({}));
    chrome.action.setBadgeText({ text: '' }); chrome.action.setTitle({ title: 'Apply' });
    return { had };
  },
  async 'get-state'({ tabId }) {
    const st = await session.get(stateKey(tabId), { frames: {} });
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const host = tab?.url ? new URL(tab.url).hostname : '';
    const rules = await local.get('rules', null);
    let server = null; let error = null;
    try { server = await api('/status'); } catch (e) { error = e.message; }
    const settings = await local.get('settings', { auto: true });
    const siteMode = rules && host ? await modeFor(rules, host) : 'off';
    const origins = host ? [`https://${host}/*`] : [];
    const granted = origins.length ? await chrome.permissions.contains({ origins }).catch(() => false) : false;
    return { host, siteMode, auto: settings.auto !== false, autoOpen: settings.autoOpen === true, submitted: await session.get(`sub:${tabId}`, null), frames: st.frames, server, error, injected: Object.keys(st.frames).length > 0, granted };
  },
  async 'set-mode'({ tabId, host, mode }) {
    const overrides = await local.get('siteModes', {});
    overrides[host] = mode;
    await local.set('siteModes', overrides);
    await toFrames(tabId, { type: 'set-mode', mode });
    return { ok: true };
  },
  async 'set-auto'({ auto, autoOpen }) {
    const now = await local.get('settings', {});
    await local.set('settings', { ...now, ...(auto !== undefined && { auto }), ...(autoOpen !== undefined && { autoOpen }) });
    return { ok: true };
  },
  rescan: async ({ tabId }) => { await toFrames(tabId, { type: 'rescan' }); return { ok: true }; },
  'fill-known': async ({ tabId }) => { await toFrames(tabId, { type: 'fill-known' }); return { ok: true }; },
  'dismiss-submitted': async ({ tabId }) => { await session.remove(`sub:${tabId}`); chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}); return { ok: true }; },
  'undo-fill': async ({ tabId }) => { await toFrames(tabId, { type: 'undo-fill' }); return { ok: true }; },
  'draft-all': async ({ tabId }) => { await toFrames(tabId, { type: 'draft-all' }); return { ok: true }; },
  draft: async ({ tabId, id }) => { await toOwner(tabId, id, { type: 'draft', id }); return { ok: true }; },
  'fill-one': async ({ tabId, id, value, source }) => { await toOwner(tabId, id, { type: 'fill-one', id, value, source }); return { ok: true }; },
  focus: async ({ tabId, id }) => { await toOwner(tabId, id, { type: 'focus', id }); return { ok: true }; },
  retry: () => api('/retry', {}),
  // The panel and the studio call the server through here. Only the paths below are reachable.
  api: ({ path, body }) => {
    if (!/^\/(cv\/[a-z/]+|setup\/[a-z_]+|style|scan\/[a-z]+|facts|answers\/[a-z]+|stats|score|preflight|applied|queue|cover|cover\/pdf|jobs|jobs\/[a-z]+|company\/[a-z]+|mail\/[a-z]+|outreach\/[a-z]+|gmail\/[a-z]+|blacklist\/[a-z]+)$/.test(path)) throw new Error(`not allowed: ${path}`);
    return api(path, body ?? {});
  },
  async 'job-context'({ tabId }) {
    const st = await session.get(stateKey(tabId), { frames: {} });
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const order = [0, ...Object.keys(st.frames).map(Number).filter((f) => f !== 0)];
    for (const frameId of order) {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'context' }, { frameId }).catch(() => null);
      if (res?.ctx && res.ctx.jd_text.length > 400) {
        // A later step of the form shows no job text; the posting seen earlier on this site stands in for it.
        const earlier = res.ctx.jd_text.length < 900 ? await session.get(`jd:${res.ctx.jd_key}`, '') : '';
        return { ...res.ctx, jd_text: earlier.length > res.ctx.jd_text.length ? earlier : res.ctx.jd_text, url: tab?.url || '' };
      }
    }
    const first = await chrome.tabs.sendMessage(tabId, { type: 'context' }, { frameId: 0 }).catch(() => null);
    return { ...(first?.ctx || { title: tab?.title || '', company: '', jd_text: '' }), url: tab?.url || '' };
  },
  async 'open-studio'({ tabId, view }) {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`app/studio.html#tab=${tabId || ''}&view=${view || 'edit'}`) });
    return { ok: true };
  },
  async 'attach-file'({ tabId, name, base64, kind }) {
    const st = await session.get(stateKey(tabId), { frames: {} });
    for (const [frameId, f] of Object.entries(st.frames)) {
      const item = (f.items || []).find((i) => (kind === 'resume' ? i.status === 'resume' : i.status === 'cover'));
      if (item) return chrome.tabs.sendMessage(tabId, { type: 'attach', id: item.id, name, base64 }, { frameId: Number(frameId) });
    }
    throw new Error(kind === 'resume' ? 'no resume upload field on this page' : 'no cover letter upload field on this page');
  },
  'upload-resume': ({ kind, base64 }) => api('/resume/upload', { kind, base64 }),
  async 'watch-tab'({ tabId }) {
    // activeTab is granted when the toolbar icon is used on this tab, so no permission prompt is needed.
    const js = chrome.runtime.getManifest().content_scripts[0].js;
    try { await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: js }); return { ok: true }; }
    catch (e) { return { error: e.message || String(e) }; }
  },
  async 'enable-site'({ host }) {
    // The panel already obtained the optional host permission from a click; register the scripts for that host.
    const manifest = chrome.runtime.getManifest();
    const js = manifest.content_scripts[0].js;
    const id = `site-${host}`;
    await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {});
    await chrome.scripting.registerContentScripts([{ id, matches: [`https://${host}/*`], js, runAt: 'document_idle', allFrames: true, persistAcrossSessions: true }]);
    return { ok: true };
  },
  async 'disable-site'({ host }) {
    await chrome.scripting.unregisterContentScripts({ ids: [`site-${host}`] }).catch(() => {});
    await chrome.permissions.remove({ origins: [`https://${host}/*`] }).catch(() => {});
    return { ok: true };
  },
};

// Which windows have Chrome's own side panel open. The panel holds a port while it is open, so a closed panel (or a restarted worker)
// is noticed by the disconnect. The in-page copy of the panel stays out of the way whenever this says a window's panel is open.
const sidePanelWindows = new Map();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;
  let windowId = null;
  port.onMessage.addListener(async (m) => {
    windowId = m.windowId;
    sidePanelWindows.set(windowId, (sidePanelWindows.get(windowId) || 0) + 1);
    const [tab] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
    if (tab) chrome.tabs.sendMessage(tab.id, { type: 'close-dock' }).catch(() => {}); // the real panel just opened: drop the in-page one
  });
  port.onDisconnect.addListener(() => {
    if (windowId == null) return;
    const n = (sidePanelWindows.get(windowId) || 1) - 1;
    n > 0 ? sidePanelWindows.set(windowId, n) : sidePanelWindows.delete(windowId);
  });
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const fromPage = sender.tab && !sender.url?.startsWith(chrome.runtime.getURL('')); // the panel may itself be open in a tab
  const table = fromPage ? handlers : panel;
  const fn = table[msg.type];
  if (!fn) return false;
  Promise.resolve().then(() => fn(msg, sender)).then(reply, (e) => reply({ error: e.message || String(e) }));   // a handler that throws at once still answers
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => { serial(tabId, () => chrome.storage.session.remove([stateKey(tabId), `sub:${tabId}`])).catch(() => {}); });
chrome.webNavigation.onCommitted.addListener((d) => { if (d.frameId === 0) serial(d.tabId, () => chrome.storage.session.remove(stateKey(d.tabId))).catch(() => {}); });
chrome.tabs.onActivated.addListener(({ tabId }) => chrome.runtime.sendMessage({ type: 'state-changed', tabId }).catch(() => {}));
