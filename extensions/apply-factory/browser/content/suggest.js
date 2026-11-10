// The on-page suggestion card. When you focus an empty box the extension could not fill from what it knows, a small card
// offers the model's answer. Nothing is written until you press Use, and you can edit the text in the card first.
(() => {
  if (!window.AF || AF.suggestCard) return;
  const CSS = `.af-card{position:absolute;z-index:2147483000;width:min(360px,calc(100vw - 24px));box-sizing:border-box;padding:10px 12px;border-radius:8px;
    background:#fbf8f4;color:#2a211d;font:13px/1.45 system-ui,sans-serif;box-shadow:0 0 0 .5px rgba(60,40,30,.3),6px 5px 14px -6px rgba(60,40,30,.35)}
    .af-card *{box-sizing:border-box;font:inherit}.af-card b{display:block;margin-bottom:6px;color:#8a4a3a;font-weight:600}
    .af-card textarea{width:100%;min-height:96px;max-height:220px;resize:vertical;padding:6px 8px;border:1px solid #d8cfc6;border-radius:6px;background:#fff;color:#2a211d}
    .af-card .af-row{display:flex;gap:6px;margin-top:8px}.af-card button{cursor:pointer;padding:5px 10px;border-radius:6px;border:1px solid #d8cfc6;background:#fff;color:#2a211d}
    .af-card button.af-use{background:#e8907a;border-color:#e8907a}.af-card button:focus-visible{outline:2px solid #c4533e;outline-offset:1px}
    .af-card p{margin:0;color:#6b5d55}`;
  const style = document.createElement('style');
  style.textContent = CSS;
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
})();
