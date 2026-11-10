// The on-page suggestion card. When you focus an empty box the extension could not fill from what it knows, a small card
// offers the model's answer. Nothing is written until you press Use, and you can edit the text in the card first.
(() => {
  if (!window.AF || AF.suggestCard) return;
  const CSS = `.af-card{position:absolute;z-index:2147483000;width:min(360px,calc(100vw - 24px));box-sizing:border-box;padding:10px 12px;border-radius:8px;
    background:#2b2522;color:#f0e9e3;font:13px/1.45 system-ui,sans-serif;box-shadow:0 0 0 1px #3a312d}
    .af-card *{box-sizing:border-box;font:inherit}.af-card b{display:block;margin-bottom:6px;color:#f0a493;font-weight:600}
    .af-card textarea{width:100%;min-height:96px;max-height:220px;resize:vertical;padding:6px 8px;border:1px solid #4a403b;border-radius:6px;background:#1d1917;color:#f0e9e3}
    .af-card .af-row{display:flex;gap:6px;margin-top:8px}.af-card button{cursor:pointer;padding:5px 10px;border-radius:6px;border:1px solid #4a403b;background:#352d2a;color:#f0e9e3}
    .af-card button.af-use{background:#e8907a;border-color:#e8907a;color:#2a1a15}.af-card button:focus-visible{outline:2px solid #c4533e;outline-offset:1px}
    .af-card p{margin:0;color:#bdb0a7}`;
  const PILL = `.af-pill{position:fixed;z-index:2147483000;right:16px;bottom:16px;display:flex;border-radius:999px;overflow:hidden;
    background:#2b2522;box-shadow:0 0 0 1px #3a312d;font:13px/1.2 system-ui,sans-serif}
    .af-pill button{all:unset;cursor:pointer;box-sizing:border-box;padding:9px 14px;color:#f0e9e3;font:inherit}
    .af-pill .af-pill-open{background:#e8907a;color:#2a1a15;font-weight:600}.af-pill .af-pill-x{padding:9px 12px;color:#bdb0a7}
    .af-pill button:focus-visible{outline:2px solid #f0a493;outline-offset:-2px}`;
  const DOCK = `.af-dock{position:fixed;z-index:2147483001;top:12px;right:12px;bottom:12px;width:min(400px,calc(100vw - 24px));display:flex;flex-direction:column;
    border-radius:10px;overflow:hidden;background:#1d1917;box-shadow:0 0 0 1px #3a312d}
    .af-dock iframe{flex:1;width:100%;border:0;background:#1d1917;color-scheme:dark}
    .af-dock .af-dock-x{all:unset;cursor:pointer;align-self:flex-end;margin:6px 10px 0;padding:3px 8px;border-radius:6px;color:#bdb0a7;font:12px system-ui,sans-serif}
    .af-dock .af-dock-x:hover{color:#f0e9e3}.af-dock .af-dock-x:focus-visible{outline:2px solid #f0a493}`;
  const style = document.createElement('style');
  style.textContent = CSS + PILL + DOCK;
  (document.head || document.documentElement).appendChild(style);

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
    card = el('div', { class: 'af-card', role: 'dialog', 'aria-label': 'Suggested answer' });
    card.style.top = `${window.scrollY + r.bottom + 6}px`;
    card.style.left = `${Math.max(8, Math.min(window.scrollX + r.left, window.scrollX + document.documentElement.clientWidth - 372))}px`;
    const dismiss = el('button', { type: 'button', text: 'Dismiss', onclick: () => { actions.dismiss(); close(); } });
    if (view.state === 'ready') {
      const box = el('textarea', { 'aria-label': 'Suggested answer, editable' });
      box.value = view.text;
      card.append(el('b', { text: 'Suggested answer' }), box,
        el('div', { class: 'af-row' }, el('button', { type: 'button', class: 'af-use', text: 'Use', onclick: () => { actions.use(box.value); close(); } }),
          el('button', { type: 'button', text: 'Write again', onclick: actions.draft }), dismiss));
    } else if (view.state === 'drafting') {
      card.append(el('b', { text: 'Suggested answer' }), el('p', { text: 'Writing from your CV...' }), el('div', { class: 'af-row' }, dismiss));
    } else if (view.state === 'offer') {
      card.append(el('b', { text: 'No saved answer for this' }),
        el('div', { class: 'af-row' }, el('button', { type: 'button', class: 'af-use', text: 'Suggest from my CV', onclick: actions.draft }), dismiss));
    } else {
      card.append(el('b', { text: 'No suggestion' }), el('p', { text: view.note || 'Your CV does not answer this.' }), el('div', { class: 'af-row' }, dismiss));
    }
    document.body.append(card);
  };
  AF.closeSuggest = close;

  // A small button on the page when a job or form is found. Chrome only lets a click open the side panel, so the extension
  // cannot open it by itself; this puts the click one tap away. It never covers the form and is dismissed per site.
  let pill = null;
  AF.launcher = ({ text, onOpen, onDismiss }) => {
    if (pill) { pill.firstChild.textContent = text; return; }
    pill = el('div', { class: 'af-pill', role: 'region', 'aria-label': 'Apply helper' },
      el('button', { type: 'button', class: 'af-pill-open', text, onclick: () => { onOpen(); pill?.remove(); } }),
      el('button', { type: 'button', class: 'af-pill-x', 'aria-label': 'Hide for this site', text: 'x', onclick: () => { onDismiss(); pill?.remove(); } }));
    document.body.append(pill);
  };
  AF.launcherShown = () => !!pill;

  // The panel drawn inside the page (like other sales and recruiting extensions do), because Chrome never lets an extension open
  // its own side panel without a click. It is the same panel page, so everything in it works the same.
  let dock = null;
  AF.dockOpen = () => !!dock;
  AF.dock = ({ onClose }) => {
    if (dock) return;
    const frame = el('iframe', { src: chrome.runtime.getURL('panel/index.html'), title: 'Apply', allow: '' });
    const close = el('button', { type: 'button', class: 'af-dock-x', 'aria-label': 'Close Apply', text: 'Close', onclick: () => { dock.remove(); dock = null; onClose?.(); } });
    dock = el('div', { class: 'af-dock', role: 'complementary', 'aria-label': 'Apply' }, close, frame);
    document.body.append(dock);
  };
})();
