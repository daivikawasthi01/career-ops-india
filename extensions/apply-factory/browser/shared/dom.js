// Tiny DOM helper shared by the side panel and the CV studio. Text always goes in through textContent,
// because labels and job text come from web pages and must never be parsed as HTML.
window.h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
};

// replaceChildren turns a null or false child into the text "null" or "false"; this drops them like h() does.
window.fill = (parent, ...kids) => parent.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
