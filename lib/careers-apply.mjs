// lib/careers-apply.mjs: turn the reviewed careers pages (data/careers-review.json) into portals.yml and
// weekly_links.txt changes. Pure: the caller reads and writes the files.
import { atsFromUrl } from './careers-discovery.mjs';
import { setFieldInText } from './portals-edit.mjs';

const same = (a, b) => a && b && a.ats === b.ats && String(a.tenant || '').toLowerCase().split('/')[0] === String(b.tenant || '').toLowerCase().split('/')[0];

/**
 * Plan from ticked rows only. kinds:
 *   same      the portals.yml board already is this one: nothing to do
 *   conflict  portals.yml has a different board for the company (written only with replaceBoards)
 *   add-new   a supported ATS board for a company not in portals.yml (written only with addNew)
 *   weekly    a custom careers page, appended to weekly_links.txt
 *   skip      ticked but unusable (no URL)
 */
export function planChanges({ review, rows, entries, weeklyText }) {
  const byRow = new Map(rows.map((r) => [r.company.toLowerCase(), r]));
  const byEntry = new Map(entries.filter((e) => e && typeof e.name === 'string').map((e) => [e.name.toLowerCase(), e]));
  const plan = [];
  for (const [company, v] of Object.entries(review)) {
    if (v?.decision !== 'ok') continue;
    const row = byRow.get(company.toLowerCase());
    const url = (v.careers_url || row?.careers_url || '').trim();
    if (!/^https?:\/\//.test(url)) { plan.push({ company, kind: 'skip', url, why: 'no usable URL' }); continue; }
    const ats = atsFromUrl(url);
    const entry = byEntry.get(company.toLowerCase());
    if (ats) {
      if (!entry) plan.push({ company, kind: 'add-new', url, why: `${ats.ats} board, company not in portals.yml` });
      else if (same(ats, atsFromUrl(entry.careers_url || entry.api || ''))) plan.push({ company, kind: 'same', url });
      else plan.push({ company, kind: 'conflict', url, current: entry.careers_url || entry.api || '(none)', why: 'portals.yml has a different board' });
    } else if ((weeklyText || '').includes(url)) plan.push({ company, kind: 'same', url });
    else plan.push({ company, kind: 'weekly', url, why: 'custom careers page' });
  }
  return plan;
}

/** New tracked_companies entry text. */
export const entryText = (name, url) => `  - name: ${/[:#,"']/.test(name) ? JSON.stringify(name) : name}\n    careers_url: ${url}\n    enabled: true\n    source: careers-review\n`;

/** Append entries at the end of the tracked_companies block (before the next top-level key). */
export function addEntries(text, items) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^tracked_companies:/.test(l));
  if (start < 0) return { text, changed: false };
  let end = lines.findIndex((l, i) => i > start && /^[A-Za-z_]/.test(l));
  if (end < 0) end = lines.length;
  while (end > start + 1 && lines[end - 1].trim() === '') end--;
  const block = items.map((i) => entryText(i.company, i.url)).join('\n').replace(/\n$/, '').split('\n');
  lines.splice(end, 0, '', ...block);
  return { text: lines.join('\n'), changed: items.length > 0 };
}

export function replaceBoards(text, items) {
  let t = text; let changed = 0;
  for (const i of items) { const r = setFieldInText(t, i.company, 'careers_url', i.url); if (r.changed) { t = r.text; changed++; } }
  return { text: t, changed };
}

export const addWeekly = (text, items) => (items.length ? `${text.replace(/\n*$/, '\n')}${items.map((i) => `${i.company} | ${i.url}`).join('\n')}\n` : text);
