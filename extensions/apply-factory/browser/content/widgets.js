// Custom dropdowns: React-Select style comboboxes (Greenhouse, Ashby), button listboxes (Workday) and searches that only
// return options a moment after you type. The page's options are read, then the server's matcher (lib/options.py) picks one,
// so there is one set of rules. When nothing matches, "Other" is chosen and the answer typed into the box that appears.
(() => {
  const AF = window.AF;
  const { norm, sleep } = AF;

  const LOADING = /^(loading|searching|please wait|\.\.\.)/i;
  const NO_RESULTS = /no (results|options|matches)|nothing found|not found|type to search/i;
  const OTHER = /^(other|others|not listed|none of the above|my .* is not listed|i can'?t find)/i;

  const visibleOptions = () => AF.queryAll('[role=option], [role=menuitem], li[data-value]').filter((o) => AF.visible(o) && norm(o.textContent));

  const listboxFor = (el) => {
    const id = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
    return id ? document.getElementById(id) : null;
  };

  const currentOptions = (el, before) => {
    const lb = listboxFor(el);
    return (lb ? [...lb.querySelectorAll('[role=option]')] : visibleOptions().filter((o) => !before.has(o))).filter((o) => AF.visible(o));
  };

  // Options that have stopped changing. A search shows "Loading" or an old list first; wait until the list holds still.
  async function settledOptions(el, before, ms) {
    const until = Date.now() + ms;
    let signature = '', since = Date.now(), last = [];
    while (Date.now() < until) {
      const all = currentOptions(el, before);
      const texts = all.map((o) => norm(o.textContent));
      const loading = texts.some((t) => LOADING.test(t));
      const noResults = texts.some((t) => NO_RESULTS.test(t));
      const real = all.filter((o, i) => !LOADING.test(texts[i]) && !NO_RESULTS.test(texts[i]));
      const sig = `${real.map((o) => norm(o.textContent)).join('|')}#${loading ? 'loading' : noResults ? 'none' : 'ok'}`;
      if (sig !== signature) { signature = sig; since = Date.now(); last = real; }
      else if (!loading && Date.now() - since >= 600 && (real.length || noResults)) return real; // a "Searching..." row means more is coming
      await sleep(150);
    }
    return last;
  }

  function open(el) {
    el.focus?.();
    if (el.tagName === 'BUTTON') { el.click(); return; }
    AF.click(el);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true }));
  }

  const close = (el) => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true })); el.blur?.(); };

  function typeInto(el, text) {
    AF.setValue(el, text);
    const key = text.slice(-1) || 'a';
    for (const type of ['keydown', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true }));
  }

  function mark(el, value, source) { AF.filled.set(el, { value, source }); el.setAttribute('data-af', source); }

  async function choose(el, value, bg, source, opts) {
    const texts = opts.map((o) => norm(o.textContent));
    const { option } = await bg('pick', { answer: value, options: texts });
    const target = option ? opts[texts.indexOf(option)] : null;
    if (!target) return false;
    AF.click(target);
    mark(el, option, source);
    return true;
  }

  // "Other" in the list, then a text box that appears near the dropdown for the real answer.
  async function typeUnderOther(el, value, source, opts) {
    const other = opts.find((o) => OTHER.test(norm(o.textContent)));
    if (!other) return false;
    AF.click(other);
    await sleep(800);
    let scope = el;
    for (let depth = 0; depth < 4 && scope.parentElement; depth++) {
      scope = scope.parentElement;
      const box = [...scope.querySelectorAll('input[type=text],input:not([type]),textarea')].find((i) => i !== el && AF.visible(i) && !i.value && !i.matches('[role=combobox]'));
      if (box) { AF.setValue(box, value); mark(el, `Other: ${value}`, source); return true; }
    }
    return false;
  }

  AF.fillCombobox = async (el, value, source, bg) => {
    const { queries } = await bg('pick', { answer: value, options: [] });
    let lastOpts = [];

    // 1. Open without typing, so lists that are already there (and aliases such as "NSUT") can be read.
    const before = new Set(visibleOptions());
    open(el);
    let opts = await settledOptions(el, before, 1800);
    if (opts.length) { lastOpts = opts; if (await choose(el, value, bg, source, opts)) return { ok: true }; }

    // 2. A search box: type the answer, then its short forms. Results can take seconds to arrive.
    if (el.tagName === 'INPUT') {
      for (const [i, q] of (queries || [value]).slice(0, 4).entries()) {
        typeInto(el, q);
        open(el);
        opts = await settledOptions(el, new Set(), i === 0 ? 6000 : 4000);
        if (opts.length) { lastOpts = opts; if (await choose(el, value, bg, source, opts)) return { ok: true }; }
      }
    }

    // 3. Nothing matched: choose Other and type the answer where the page asks for it.
    if (lastOpts.length && await typeUnderOther(el, value, source, lastOpts)) return { ok: true, note: 'typed under Other' };
    if (el.tagName === 'INPUT') AF.setValue(el, '');
    close(el);
    return { ok: false, reason: lastOpts.length ? 'no matching option' : 'no options appeared' };
  };
})();
