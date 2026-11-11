// The on-page suggestion card. When you focus an empty box the extension could not fill from what it knows, a small card
// offers the model's answer. Nothing is written until you press Use, and you can edit the text in the card first.
(() => {
  if (!window.AF || AF.suggestCard) return;
  // The panel's two themes (dark, and "Porcelain" light) as plain CSS variables, shared by every on-page element: card, pill, dock, chip.
  // Dark is the default; <html data-af-theme="light"> switches them. The theme is the one chosen in the panel (chrome.storage afTheme),
  // else the operating system's.
  const TOKENS = `.af-card,.af-pill,.af-dock,.af-chip{--af-bg:#111113;--af-fg:#f4f4f5;--af-muted:#8e8e97;--af-border:rgb(255 255 255 / 12%);--af-input:#070708;
    --af-primary:#f4f4f5;--af-primary-fg:#09090b;--af-secondary:#1b1b1e;--af-hover:#26262a;--af-ring:#71717a;--af-radius:10px;--af-dock-bg:#070708;
    --af-shadow:0 8px 28px rgb(0 0 0 / 45%);color-scheme:dark;font-family:"Geist Variable",ui-sans-serif,system-ui,sans-serif}
    html[data-af-theme="light"] :is(.af-card,.af-pill,.af-dock,.af-chip){--af-bg:#fcfbf8;--af-fg:#1c1915;--af-muted:#6f6a62;--af-border:#e2ded5;--af-input:#f7f5f0;
    --af-primary:#1c1915;--af-primary-fg:#f7f5f0;--af-secondary:#eeebe3;--af-hover:#e5e1d7;--af-ring:#8a847a;--af-dock-bg:#f7f5f0;
    --af-shadow:0 8px 28px rgb(28 25 21 / 16%);color-scheme:light}`;
  const CSS = `.af-card{position:absolute;z-index:2147483000;width:min(360px,calc(100vw - 24px));box-sizing:border-box;padding:12px;border-radius:var(--af-radius);
    background:var(--af-bg);color:var(--af-fg);font-size:13px;line-height:1.45;box-shadow:0 0 0 1px var(--af-border),var(--af-shadow)}
    .af-card *{box-sizing:border-box;font:inherit}.af-card b{display:block;margin-bottom:6px;color:var(--af-fg);font-weight:600}
    .af-card textarea{width:100%;min-height:96px;max-height:220px;resize:vertical;padding:8px;border:1px solid var(--af-border);border-radius:calc(var(--af-radius) - 2px);background:var(--af-input);color:var(--af-fg)}
    .af-card textarea:focus-visible{outline:2px solid var(--af-ring);outline-offset:1px}
    .af-card .af-row{display:flex;gap:6px;margin-top:8px}.af-card button{cursor:pointer;padding:5px 10px;border-radius:calc(var(--af-radius) - 2px);border:1px solid var(--af-border);background:var(--af-secondary);color:var(--af-fg)}
    .af-card button:hover{background:var(--af-hover)}
    .af-card button.af-use{background:var(--af-primary);border-color:var(--af-primary);color:var(--af-primary-fg);font-weight:500}.af-card button:focus-visible{outline:2px solid var(--af-ring);outline-offset:1px}
    .af-card p{margin:0;color:var(--af-muted)}`;
  const PILL = `.af-pill{position:fixed;z-index:2147483000;right:16px;bottom:16px;display:flex;border-radius:999px;overflow:hidden;
    background:var(--af-bg);box-shadow:0 0 0 1px var(--af-border),var(--af-shadow);font-size:13px;line-height:1.2}
    .af-pill button{all:unset;cursor:pointer;box-sizing:border-box;padding:9px 14px;color:var(--af-fg);font:inherit}
    .af-pill .af-pill-open{background:var(--af-primary);color:var(--af-primary-fg);font-weight:500}.af-pill .af-pill-x{padding:9px 12px;color:var(--af-muted)}
    .af-pill .af-pill-x:hover{color:var(--af-fg)}
    .af-pill button:focus-visible{outline:2px solid var(--af-ring);outline-offset:-2px}`;
  const DOCK = `.af-dock{position:fixed;z-index:2147483001;top:12px;right:12px;bottom:12px;width:min(400px,calc(100vw - 24px));display:flex;flex-direction:column;
    border-radius:var(--af-radius);overflow:hidden;background:var(--af-dock-bg);box-shadow:0 0 0 1px var(--af-border),var(--af-shadow)}
    .af-dock iframe{flex:1;width:100%;border:0;background:var(--af-dock-bg)}
    .af-dock .af-dock-x{all:unset;cursor:pointer;align-self:flex-end;margin:6px 10px 0;padding:3px 8px;border-radius:6px;color:var(--af-muted);font-size:12px}
    .af-dock .af-dock-x:hover{color:var(--af-fg)}.af-dock .af-dock-x:focus-visible{outline:2px solid var(--af-ring)}`;
  const CHIP = `.af-chip{position:absolute;z-index:2147482000;display:inline-flex;max-width:min(420px,60vw);border-radius:999px;overflow:hidden;background:var(--af-bg);
    box-shadow:0 0 0 1px var(--af-border),var(--af-shadow);font-size:12px;line-height:1.3}
    .af-chip button{all:unset;cursor:pointer;box-sizing:border-box;padding:4px 10px;color:var(--af-fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:inherit}
    .af-chip[data-tone="ready"] .af-chip-main{background:var(--af-primary);color:var(--af-primary-fg);font-weight:500}
    .af-chip button[disabled]{cursor:default;color:var(--af-muted)}.af-chip .af-chip-side{color:var(--af-muted);padding-inline:8px;border-inline-start:1px solid var(--af-border)}
    .af-chip .af-chip-side:hover{color:var(--af-fg)}.af-chip button:focus-visible{outline:2px solid var(--af-ring);outline-offset:-2px}`;
  const style = document.createElement('style');
  style.textContent = TOKENS + CSS + PILL + DOCK + CHIP;
  (document.head || document.documentElement).appendChild(style);

  // Theme: the panel's saved choice wins, else follow the OS. Storage can be unavailable (orphaned script after a reload): then dark.
  const setTheme = (t) => document.documentElement.setAttribute('data-af-theme', t === 'light' ? 'light' : 'dark');
  const osTheme = () => (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  let chosen = null;
  setTheme(osTheme());
  try {
    chrome.storage.local.get('afTheme', (v) => { chosen = v?.afTheme || null; setTheme(chosen || osTheme()); });
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.afTheme) { chosen = ch.afTheme.newValue || null; setTheme(chosen || osTheme()); } });
    window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (!chosen) setTheme(osTheme()); });
  } catch { /* keep the OS theme */ }

  let card = null;
  const close = () => { card?.remove(); card = null; };
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) k === 'text' ? (n.textContent = v) : k.startsWith('on') ? n.addEventListener(k.slice(2), v) : n.setAttribute(k, v);
    kids.forEach((c) => c && n.append(c));
    return n;
  };

  // view: { state: 'ready' | 'drafting' | 'offer' | 'none', text, note }; actions: { use(text), draft(), dismiss() }
  AF.suggestCard = (anchor, view, actions) => {
    close();
    const r = anchor.getBoundingClientRect();
    card = el('div', { class: 'af-card', role: 'dialog', 'aria-label': 'Drafted answer' });
    card.style.top = `${window.scrollY + r.bottom + 6}px`;
    card.style.left = `${Math.max(8, Math.min(window.scrollX + r.left, window.scrollX + document.documentElement.clientWidth - 372))}px`;
    const dismiss = el('button', { type: 'button', text: 'Dismiss', onclick: () => { actions.dismiss(); close(); } });
    if (view.state === 'ready') {
      const box = el('textarea', { 'aria-label': 'Drafted answer, editable' });
      box.value = view.text;
      card.append(el('b', { text: 'Drafted answer' }), box,
        el('div', { class: 'af-row' }, el('button', { type: 'button', class: 'af-use', text: 'Insert answer', onclick: () => { actions.use(box.value); close(); } }),
          el('button', { type: 'button', text: 'Draft again', onclick: actions.draft }), dismiss));
    } else if (view.state === 'drafting') {
      card.append(el('b', { text: 'Drafted answer' }), el('p', { text: 'Drafting from your CV...' }), el('div', { class: 'af-row' }, dismiss));
    } else if (view.state === 'offer') {
      card.append(el('b', { text: 'No saved answer for this' }), view.note ? el('p', { text: view.note }) : null,
        el('div', { class: 'af-row' }, el('button', { type: 'button', class: 'af-use', text: 'Draft from my CV', onclick: actions.draft }), dismiss));
    } else {
      card.append(el('b', { text: 'No suggestion' }), el('p', { text: view.note || 'Your CV does not answer this.' }), el('div', { class: 'af-row' }, dismiss));
    }
    document.body.append(card);
  };
  AF.closeSuggest = close;

  // A small chip beside each open question, so a suggestion is visible on the page itself without clicking into the box.
  // The chip follows its field (scrolling, re-layout) and goes away when the field does.
  const chips = new Map();
  const place = (c) => {
    const r = c.anchor.getBoundingClientRect();
    if (!c.anchor.isConnected || (r.width === 0 && r.height === 0)) { c.node.style.display = 'none'; return; }
    c.node.style.display = '';
    const w = c.node.offsetWidth;
    const room = document.documentElement.clientWidth - r.right;
    const left = room >= w + 14 ? r.right + 8 : r.right - w - 6; // beside the field when there is room, else inside its right edge
    c.node.style.top = `${window.scrollY + r.top + Math.max(0, (r.height - c.node.offsetHeight) / 2)}px`;
    c.node.style.left = `${window.scrollX + Math.max(4, left)}px`;
  };
  // actions: extra small buttons after the main one, [{ text, label, onClick }]
  AF.chip = (id, anchor, { text, tone, onClick, title = '', actions = [] }) => {
    let c = chips.get(id);
    if (!c) {
      const node = el('span', { class: 'af-chip' });
      document.body.append(node);
      c = { node, anchor };
      chips.set(id, c);
      tick();
    }
    c.anchor = anchor;
    c.node.dataset.tone = tone;
    const main = el('button', { type: 'button', class: 'af-chip-main', text, title });
    main.disabled = !onClick;
    if (onClick) main.addEventListener('click', onClick);
    c.node.replaceChildren(main, ...actions.map((a) => el('button', { type: 'button', class: 'af-chip-side', text: a.text, 'aria-label': a.label || a.text, onclick: a.onClick })));
    place(c);
  };
  AF.dropChip = (id) => { const c = chips.get(id); if (c) { c.node.remove(); chips.delete(id); } };
  AF.keepChips = (ids) => { for (const [id, c] of chips) if (!ids.has(id)) { c.node.remove(); chips.delete(id); } };
  const replace = () => chips.forEach(place);
  window.addEventListener('scroll', replace, true);
  window.addEventListener('resize', replace);
  // Layout can shift without a scroll or resize, so chips are re-placed on a timer, but only while there are chips: this script is loaded
  // in every frame of every page, and an idle timer in each of them is a cost for nothing.
  let timer = null;
  function tick() {
    if (timer || !chips.size) return;
    timer = setInterval(() => { if (!chips.size) { clearInterval(timer); timer = null; return; } replace(); }, 700);
  }

  // A small button on the page when a job or form is found. Chrome only lets a click open the side panel, so the extension
  // cannot open it by itself; this puts the click one tap away. It never covers the form and is dismissed per site.
  let pill = null;
  AF.launcher = ({ text, onOpen, onDismiss }) => {
    if (pill) { pill.firstChild.textContent = text; return; }
    pill = el('div', { class: 'af-pill', role: 'region', 'aria-label': 'Apply helper' },
      el('button', { type: 'button', class: 'af-pill-open', text, onclick: () => { onOpen(); pill?.remove(); } }),
      el('button', { type: 'button', class: 'af-pill-x', 'aria-label': 'Hide for this tab', text: '\u00d7', onclick: () => { onDismiss(); pill?.remove(); } }));
    document.body.append(pill);
  };
  AF.launcherShown = () => !!pill;

  // The panel drawn inside the page (like other sales and recruiting extensions do), because Chrome never lets an extension open
  // its own side panel without a click. It is the same panel page, so everything in it works the same.
  let dock = null;
  AF.dockOpen = () => !!dock;
  AF.closeDock = () => { dock?.remove(); dock = null; pill?.remove(); pill = null; };
  AF.dock = ({ onClose }) => {
    if (dock) return;
    const frame = el('iframe', { src: chrome.runtime.getURL('app/panel.html'), title: 'Apply', allow: '' });
    const close = el('button', { type: 'button', class: 'af-dock-x', 'aria-label': 'Close Apply', text: 'Close', onclick: () => { dock.remove(); dock = null; onClose?.(); } });
    dock = el('div', { class: 'af-dock', role: 'complementary', 'aria-label': 'Apply' }, close, frame);
    document.body.append(dock);
  };
})();
