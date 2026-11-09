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
