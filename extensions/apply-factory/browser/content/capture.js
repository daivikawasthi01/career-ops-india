// Learns your final answers. A capture is taken when you press a Next/Submit-style button or a form submits,
// so edits made along the way are never recorded, only what was in the fields at that moment.
// This never clicks anything and never blocks the click.
(() => {
  const AF = window.AF;
  const { norm } = AF;

  AF.toWire = (field) => {
    const h = AF.handles.get(field.id);
    const el = h?.els[0];
    const prefill = el ? AF.filled.get(el) : null;
    let value = field.value;
    if (h?.kind === 'text' || h?.kind === 'combobox') value = h.kind === 'combobox' && el.tagName === 'BUTTON' ? norm(el.textContent) : el.value ?? field.value;
    return {
      label: field.label, field_type: field.type, value, options: field.options, name: field.name, placeholder: field.placeholder,
      autocomplete: field.autocomplete, was_prefilled: !!prefill, prefilled_value: prefill ? prefill.value : null,
    };
  };

  // Re-reads the DOM at capture time so the values are the final ones.
  AF.snapshot = (neverRead) => {
    const fields = AF.collect(neverRead);
    // A "No" is a real answer for a choose-one question (sponsorship, relocation); only an empty value or an unticked box is skipped.
    return fields.filter((f) => f.type !== 'file').map(AF.toWire).filter((f) => f.value !== undefined && f.value !== null && String(f.value).trim() !== '');
  };

  AF.watchSubmit = ({ submitRe, onCapture }) => {
    const looksLikeSubmit = (el) => {
      const b = el.closest?.('button,[role=button],input[type=submit],input[type=button],a.btn,a[role=button]');
      if (!b) return false;
      const text = norm(b.value || b.getAttribute('aria-label') || b.textContent);
      return text.length < 40 && submitRe.test(text);
    };
    // "Final" is stricter than "submit-like": Next and Continue also save the page, but only Submit-style words mean the application is sent.
    const FINAL = /\b(submit|send application|finish|complete (application|registration))\b/i;
    const isFinal = (el) => { const b = el.closest?.('button,[role=button],input[type=submit],input[type=button],a.btn,a[role=button]'); return !!b && FINAL.test(norm(b.value || b.getAttribute('aria-label') || b.textContent)); };
    document.addEventListener('click', (e) => { if (e.isTrusted && looksLikeSubmit(e.target)) onCapture('click', isFinal(e.target)); }, true);
    document.addEventListener('submit', (e) => { if (e.isTrusted) onCapture('submit', true); }, true);
  };
})();
