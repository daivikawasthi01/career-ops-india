// lib/portals-edit.mjs: small, careful edits to portals.yml text (a user-layer file).
// Text edits, not a YAML round trip, so comments and layout survive.

import { copyFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { renameSyncWithRetry } from '../tracker-utils.mjs';

/** True when a discover-ats.mjs process is running; it also rewrites portals.yml. */
export function discoverIsRunning() {
  try {
    const out = execFileSync('pgrep', ['-fl', 'discover-ats.mjs'], { encoding: 'utf8' });
    return out.split('\n').filter((l) => l && !l.includes('pgrep')).length > 0;
  } catch {
    return false; // pgrep exits 1 when nothing matches
  }
}

/** Copy `path` to `path.bak-<timestamp>` and return the backup path. */
export function backupFile(path) {
  const backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(path, backup);
  return backup;
}

/** Write text to path through a temp file and a rename. */
export function atomicWrite(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf-8');
  renameSyncWithRetry(tmp, path);
}

const unquote = (v) => String(v).trim().replace(/^(['"])(.*)\1$/, '$2');

/**
 * Set `enabled:` for the tracked_companies entry called `name`.
 * Adds the line when the entry has none. `note` becomes a comment under it.
 * @returns {{text: string, changed: boolean, found: boolean}}
 */
export function setEnabledInText(text, name, enabled, note = '') {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => {
    const m = l.match(/^  - name:\s*(.+?)\s*$/);
    return m && unquote(m[1]) === name;
  });
  if (start < 0) return { text, changed: false, found: false };

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  - /.test(lines[i]) || /^[^\s#]/.test(lines[i])) { end = i; break; }
  }
  const value = enabled ? 'true' : 'false';
  const idx = lines.slice(start, end).findIndex((l) => /^    enabled:/.test(l));
  const noteLine = note ? `    # ${note}` : null;

  if (idx >= 0) {
    const at = start + idx;
    const current = lines[at].match(/^    enabled:\s*(\S+)/)?.[1];
    if (current === value) return { text, changed: false, found: true };
    lines[at] = `    enabled: ${value}`;
    if (noteLine) lines.splice(at + 1, 0, noteLine);
  } else {
    lines.splice(start + 1, 0, `    enabled: ${value}`, ...(noteLine ? [noteLine] : []));
  }
  return { text: lines.join('\n'), changed: true, found: true };
}

/** Line range [start, end) of the tracked_companies entry called `name`, or null. */
function entryRange(lines, name) {
  const start = lines.findIndex((l) => {
    const m = l.match(/^  - name:\s*(.+?)\s*$/);
    return m && unquote(m[1]) === name;
  });
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  - /.test(lines[i]) || /^[^\s#]/.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

/**
 * Set a scalar `key: value` on the entry called `name` (after its `enabled:` line, else after the name).
 * @returns {{text: string, changed: boolean, found: boolean}}
 */
export function setFieldInText(text, name, key, value) {
  const lines = text.split('\n');
  const r = entryRange(lines, name);
  if (!r) return { text, changed: false, found: false };
  const re = new RegExp(`^    ${key}:`);
  const idx = lines.slice(r.start, r.end).findIndex((l) => re.test(l));
  if (idx >= 0) {
    const at = r.start + idx;
    if (lines[at].match(new RegExp(`^    ${key}:\\s*(\\S+)`))?.[1] === String(value)) return { text, changed: false, found: true };
    lines[at] = `    ${key}: ${value}`;
  } else {
    const en = lines.slice(r.start, r.end).findIndex((l) => /^    enabled:/.test(l));
    // Skip any comment lines that belong to the enabled line, so a note stays attached to it.
    let at = r.start + (en >= 0 ? en : 0) + 1;
    while (en >= 0 && at < r.end && /^    #/.test(lines[at])) at++;
    lines.splice(at, 0, `    ${key}: ${value}`);
  }
  return { text: lines.join('\n'), changed: true, found: true };
}

/** Names of entries carrying a "# auto-disabled <date> by board-india-check" note. */
export function autoDisabledNames(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^  - name:\s*(.+?)\s*$/);
    if (!m) continue;
    const name = unquote(m[1]);
    const r = entryRange(lines, name);
    if (r && lines.slice(r.start, r.end).some((l) => /^\s+# auto-disabled \S+ by board-india-check/.test(l))) out.push(name);
  }
  return out;
}

/** Remove a scalar `key:` line from the entry called `name`. Notes and everything else stay. */
export function removeFieldInText(text, name, key) {
  const lines = text.split('\n');
  const r = entryRange(lines, name);
  if (!r) return { text, changed: false, found: false };
  const re = new RegExp(`^    ${key}:`);
  const idx = lines.slice(r.start, r.end).findIndex((l) => re.test(l));
  if (idx < 0) return { text, changed: false, found: true };
  lines.splice(r.start + idx, 1);
  return { text: lines.join('\n'), changed: true, found: true };
}
