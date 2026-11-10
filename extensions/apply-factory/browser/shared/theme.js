// Dark is the default. The choice is remembered per browser profile in localStorage, which may be blocked, so every access is guarded.
(() => {
  const KEY = 'af-theme';
  const read = () => { try { return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; } };
  const apply = (t) => { document.documentElement.dataset.theme = t; };
  apply(read());
  window.AFTheme = {
    current: read,
    toggle() {
      const next = read() === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(KEY, next); } catch { /* the choice just lasts until the page closes */ }
      apply(next);
      return next;
    },
  };
})();
