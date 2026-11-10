// Field discovery and filling. Plain classic script: the four content files share window.AF.
// Nothing here talks to the network; main.js asks the background worker for that.
(() => {
  if (window.AF) return;
  const AF = (window.AF = { filled: new WeakMap() });

  const style = document.createElement('style');
  style.textContent = '[data-af="fact"],[data-af="kb"],[data-af="similar"],[data-af="user"]{box-shadow:inset 3px 0 0 #e8907a !important}[data-af="draft"],[data-af="report"]{box-shadow:inset 3px 0 0 #d9b46a !important}[data-af="missing"]{outline:2px solid #c4533e !important;outline-offset:1px}';
  (document.head || document.documentElement).appendChild(style);

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  AF.norm = norm;

  // ---- DOM access, including open shadow roots ----
  AF.queryAll = (selector, root = document) => {
    const found = [...root.querySelectorAll(selector)];
    for (const host of root.querySelectorAll('*')) if (host.shadowRoot) found.push(...AF.queryAll(selector, host.shadowRoot));
    return found;
  };
  const rootOf = (el) => el.getRootNode?.() || document;

  AF.visible = (el) => {
    if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };

  // ---- labels ----
  const textOf = (el) => {
    const c = el.cloneNode(true);
    c.querySelectorAll('input,select,textarea,button,script,style,svg,[aria-hidden=true]').forEach((n) => n.remove());
    return norm(c.textContent);
  };
  const clean = (t) => norm(t).replace(/\s*[*✱]\s*$/, '').replace(/\s*\((required|optional)\)\s*$/i, '').replace(/\s*required\s*$/i, '').replace(/[:：]\s*$/, '').slice(0, 220);

  const byId = (el, id) => rootOf(el).getElementById?.(id) || document.getElementById(id);

  const hasControl = (n) => n.matches?.('input,select,textarea') || n.querySelector?.('input,select,textarea');

  // The closest text before the control: walk up a few levels and take the last earlier sibling that holds text.
  function nearbyLabel(el) {
    let node = el;
    for (let depth = 0; depth < 5 && node && node !== document.body; depth++, node = node.parentElement) {
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (hasControl(sib) && !sib.matches('label,legend')) break;
        const t = textOf(sib);
        if (t.length >= 2 && t.length <= 220) return t;
      }
    }
    return '';
  }

  function groupLabel(el) {
    const fs = el.closest('fieldset');
    const legend = fs?.querySelector('legend');
    if (legend && textOf(legend)) return textOf(legend);
    const grp = el.closest('[role=radiogroup],[role=group]');
    if (grp) {
      const lb = grp.getAttribute('aria-labelledby');
      if (lb) { const t = lb.split(/\s+/).map((id) => byId(el, id)).filter(Boolean).map(textOf).join(' '); if (t) return t; }
      if (grp.getAttribute('aria-label')) return grp.getAttribute('aria-label');
    }
    return '';
  }

  AF.labelOf = (el, { group = false } = {}) => {
    if (group) { const g = groupLabel(el); if (g) return clean(g); }
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(/\s+/).map((id) => byId(el, id)).filter(Boolean).map(textOf).join(' '); if (t) return clean(t); }
    if (el.id) {
      const l = rootOf(el).querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && textOf(l)) return clean(textOf(l));
    }
    const wrap = el.closest('label');
    if (wrap && textOf(wrap) && !group) return clean(textOf(wrap));
    if (el.getAttribute('aria-label')) return clean(el.getAttribute('aria-label'));
    return clean(nearbyLabel(el)) || clean(el.placeholder || el.name || '');
  };

  const optionLabel = (el) => {
    if (el.id) { const l = rootOf(el).querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l && textOf(l)) return clean(textOf(l)); }
    const wrap = el.closest('label');
    if (wrap && textOf(wrap)) return clean(textOf(wrap));
    return clean(el.getAttribute('aria-label') || el.nextSibling?.textContent || el.nextElementSibling?.textContent || el.value || '');
  };

  const isChecked = (el) => (typeof el.checked === 'boolean' ? el.checked : el.getAttribute('aria-checked') === 'true');
  AF.isChecked = isChecked;

  // A checkbox's own words: an explicit label, else the text right beside it, else the list item or paragraph that holds only this
  // box. The nearest heading above is the last resort, never the first: it names the section, not the statement.
  function statementLabel(el) {
    const lb = el.getAttribute('aria-labelledby');
    const explicit = (el.id && rootOf(el).querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest('label');
    const viaLabel = explicit ? clean(textOf(explicit)) : '';
    if (viaLabel) return viaLabel;
    if (el.getAttribute('aria-label')) return clean(el.getAttribute('aria-label'));
    if (lb) { const t = lb.split(/\s+/).map((id) => byId(el, id)).filter(Boolean).map(textOf).join(' '); if (t) return clean(t); }
    const next = clean(el.nextElementSibling?.textContent || el.nextSibling?.textContent || '');
    if (next.length >= 3) return next;
    const holder = el.closest('li,p,div,td');
    if (holder && holder.querySelectorAll('input,select,textarea').length === 1 && clean(textOf(holder)).length >= 3) return clean(textOf(holder));
    return AF.labelOf(el);
  }

  // ---- collecting ----
  const SKIP_INPUT = new Set(['hidden', 'submit', 'button', 'image', 'reset', 'password', 'search']);
  let counter = 0;
  const idOf = new WeakMap();
  const stableId = (el) => { if (!idOf.has(el)) idOf.set(el, `f${++counter}`); return idOf.get(el); };

  const usable = (el) => {
    if (el.disabled || el.readOnly || el.closest('[role=search],[hidden],[inert]')) return false;
    if (el.type === 'file') return true; // file inputs are usually hidden behind a styled button
    return AF.visible(el);
  };

  const comboValue = (el) => (el.tagName === 'BUTTON' ? norm(el.textContent) : el.value || '');
  const isPlaceholder = (t) => !t || /^(select|choose|please select|--|pick)/i.test(t);

  // Returns the wire fields (no DOM) and fills AF.handles with the elements behind each id.
  AF.handles = new Map();
  AF.collect = (neverRead = () => false) => {
    AF.handles = new Map();
    const fields = [];
    const seenGroups = new Set();
    const nodes = AF.queryAll('input, select, textarea, button[aria-haspopup=listbox], [role=combobox]:not(input), [role=checkbox]:not(input), [role=switch]:not(input), [role=radio]:not(input)');
    for (const el of nodes) {
      if (el.tagName === 'INPUT' && SKIP_INPUT.has(el.type)) continue;
      if (!usable(el)) continue;
      const base = { name: el.name || '', placeholder: el.placeholder || '', autocomplete: el.getAttribute('autocomplete') || '',
        maxlength: el.maxLength > 0 ? el.maxLength : 0, required: !!el.required || el.getAttribute('aria-required') === 'true' };
      let field;

      if (el.matches('[role=checkbox],[role=switch]') && el.tagName !== 'INPUT') { // a styled div or li that behaves as a checkbox
        const id = stableId(el);
        field = { ...base, id, type: 'checkbox', label: clean(textOf(el) || el.getAttribute('aria-label') || ''), options: ['Yes', 'No'], value: isChecked(el) ? 'Yes' : '' };
        AF.handles.set(id, { kind: 'checkbox', els: [el] });
      } else if (el.matches('[role=radio]') && el.tagName !== 'INPUT') {
        const group = el.closest('[role=radiogroup]') || el.parentElement;
        const key = `role|${stableId(group)}`;
        if (seenGroups.has(key)) continue;
        seenGroups.add(key);
        const radios = [...group.querySelectorAll('[role=radio]')];
        const labels = radios.map((r) => clean(textOf(r) || r.getAttribute('aria-label') || ''));
        const checked = radios.findIndex(isChecked);
        field = { ...base, id: stableId(radios[0]), type: 'radio', label: AF.labelOf(group, { group: true }) || clean(nearbyLabel(group)), options: labels, value: checked >= 0 ? labels[checked] : '' };
        AF.handles.set(field.id, { kind: 'radio', els: radios, labels });
      } else if (el.type === 'radio') {
        const key = `${el.form?.id || ''}|${el.name || stableId(el.closest('fieldset,[role=radiogroup]') || el.parentElement)}`;
        if (seenGroups.has(key)) continue;
        seenGroups.add(key);
        const radios = AF.queryAll(`input[type=radio]${el.name ? `[name="${CSS.escape(el.name)}"]` : ''}`, rootOf(el)).filter((r) => (el.name ? r.form === el.form : true) && !r.disabled);
        const labels = radios.map(optionLabel);
        const checked = radios.findIndex((r) => r.checked);
        field = { ...base, id: stableId(radios[0]), type: 'radio', label: AF.labelOf(radios[0], { group: true }), options: labels, value: checked >= 0 ? labels[checked] : '' };
        AF.handles.set(field.id, { kind: 'radio', els: radios, labels });
      } else if (el.type === 'checkbox') {
        const mates = el.name ? AF.queryAll(`input[type=checkbox][name="${CSS.escape(el.name)}"]`, rootOf(el)).filter((c) => c.form === el.form) : [el];
        const key = `cb|${el.form?.id || ''}|${el.name || stableId(el)}`;
        if (seenGroups.has(key)) continue;
        seenGroups.add(key);
        if (mates.length > 1) {
          const labels = mates.map(statementLabel);
          field = { ...base, id: stableId(mates[0]), type: 'multiselect', label: AF.labelOf(mates[0], { group: true }), options: labels,
            value: labels.filter((_, i) => mates[i].checked).join('; ') };
          AF.handles.set(field.id, { kind: 'multiselect', els: mates, labels });
        } else {
          field = { ...base, id: stableId(el), type: 'checkbox', label: statementLabel(el), options: ['Yes', 'No'], value: el.checked ? 'Yes' : '' };
          AF.handles.set(field.id, { kind: 'checkbox', els: [el] });
        }
      } else if (el.tagName === 'SELECT') {
        const opts = [...el.options].map((o) => norm(o.text));
        const sel = el.selectedIndex >= 0 ? opts[el.selectedIndex] : '';
        field = { ...base, id: stableId(el), type: 'select', label: AF.labelOf(el), options: opts, value: isPlaceholder(sel) ? '' : sel };
        AF.handles.set(field.id, { kind: 'select', els: [el] });
      } else if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete')) {
        const v = comboValue(el);
        field = { ...base, id: stableId(el), type: 'combobox', label: AF.labelOf(el), options: [], value: isPlaceholder(v) ? '' : v };
        AF.handles.set(field.id, { kind: 'combobox', els: [el] });
      } else if (el.type === 'file') {
        field = { ...base, id: stableId(el), type: 'file', label: AF.labelOf(el), options: [], value: el.files?.length ? el.files[0].name : '' };
        AF.handles.set(field.id, { kind: 'file', els: [el] });
      } else {
        const type = el.tagName === 'TEXTAREA' ? 'textarea' : ['email', 'tel', 'url', 'number', 'date'].includes(el.type) ? el.type : 'text';
        field = { ...base, id: stableId(el), type, label: AF.labelOf(el), options: [], value: el.value || '' };
        AF.handles.set(field.id, { kind: 'text', els: [el] });
      }
      if (!field.label || neverRead(field)) { AF.handles.delete(field.id); continue; }
      fields.push(field);
    }
    return fields;
  };

  // ---- filling ----
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  AF.sleep = sleep;

  AF.setValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    el.focus?.();
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); // bypasses React's value tracker
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur?.();
  };

  const mark = (el, value, source) => { AF.filled.set(el, { value, source }); el.setAttribute('data-af', source); };

  const click = (el) => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  };
  AF.click = click;

  AF.fill = async (id, value, source = 'fact', bg) => {
    const h = AF.handles.get(id);
    if (!h) return { ok: false, reason: 'field left the page' };
    const el = h.els[0];
    try {
      if (h.kind === 'text') { AF.setValue(el, value); mark(el, value, source); return { ok: true }; }
      if (h.kind === 'select') {
        const i = [...el.options].findIndex((o) => norm(o.text) === norm(value));
        if (i < 0) return { ok: false, reason: 'option not found' };
        AF.setValue(el, el.options[i].value);
        mark(el, value, source);
        return { ok: true };
      }
      if (h.kind === 'radio') {
        const i = h.labels.findIndex((l) => norm(l) === norm(value));
        if (i < 0) return { ok: false, reason: 'option not found' };
        if (!isChecked(h.els[i])) click(h.els[i]);
        mark(h.els[0], value, source);
        return { ok: true };
      }
      if (h.kind === 'checkbox') {
        const want = /^(yes|true|y)$/i.test(value);
        if (isChecked(el) !== want) click(el);
        mark(el, value, source);
        return { ok: true };
      }
      if (h.kind === 'multiselect') {
        const wanted = value.split(/;\s*/).map(norm);
        h.els.forEach((c, i) => { if (wanted.includes(norm(h.labels[i])) !== isChecked(c)) click(c); });
        mark(h.els[0], value, source);
        return { ok: true };
      }
      if (h.kind === 'combobox') return await AF.fillCombobox(el, value, source, bg);
      if (h.kind === 'file') return { ok: false, reason: 'use attachFile' };
    } catch (e) {
      return { ok: false, reason: String(e.message || e).slice(0, 120) };
    }
    return { ok: false, reason: 'unsupported field' };
  };

  AF.attachFile = async (id, name, base64, replace = false) => {
    const h = AF.handles.get(id);
    const el = h?.els[0];
    if (!el) return { ok: false, reason: 'field left the page' };
    if (el.files?.length && !replace) return { ok: true, reason: 'already has a file' };
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: 'application/pdf' }));
    el.files = dt.files;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.setAttribute('data-af', 'fact');
    return { ok: true };
  };

  // ---- empty required fields ----
  AF.isEmpty = (id) => {
    const h = AF.handles.get(id);
    if (!h) return false;
    if (h.kind === 'radio' || h.kind === 'multiselect') return !h.els.some(isChecked);
    if (h.kind === 'checkbox') return !isChecked(h.els[0]);
    if (h.kind === 'file') return !h.els[0].files?.length;
    if (h.kind === 'combobox') return !(h.els[0].tagName === 'BUTTON' ? norm(h.els[0].textContent) && !isPlaceholder(norm(h.els[0].textContent)) : h.els[0].value);
    if (h.kind === 'select') return isPlaceholder(norm(h.els[0].options[h.els[0].selectedIndex]?.text));
    return !(h.els[0].value || '').trim();
  };
  AF.flagMissing = () => {
    for (const [id, h] of AF.handles) {
      const required = h.els.some((e) => e.required || e.getAttribute('aria-required') === 'true');
      const el = h.els[0];
      if (required && AF.isEmpty(id)) el.setAttribute('data-af', 'missing');
      else if (el.getAttribute('data-af') === 'missing') el.removeAttribute('data-af');
    }
  };

  // ---- page context for drafts ----
  AF.pageContext = () => {
    const meta = (p) => document.querySelector(`meta[property="${p}"],meta[name="${p}"]`)?.content || '';
    const seg = location.pathname.split('/').filter(Boolean)[0] || '';
    const ats = /greenhouse|lever|ashby|workable|smartrecruiters|recruitee|jobvite|breezy|teamtailor/.test(location.hostname);
    const company = norm(meta('og:site_name')) || (ats ? seg : location.hostname.replace(/^(www|jobs|careers)\./, '').split('.')[0]);
    const main = document.querySelector('main,[role=main]') || document.body;
    return { title: norm(document.title).slice(0, 160), heading: norm(document.querySelector('h1')?.textContent).slice(0, 160), company: company.slice(0, 80), jd_text: norm(main.innerText || '').slice(0, 3500), host: location.hostname, jd_key: `${location.hostname}/${seg}` };
  };
})();
