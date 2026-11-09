// lib/progress.mjs: a tqdm-style progress line for long runs, no dependency.
//
// In a terminal it keeps one live line at the bottom (bar, count, percent, outcome counts, seconds per item, ETA) and prints every log line
// above it. console.log and console.error are routed through it while it is active, so searches, warnings and per-company lines never
// tear the bar. Without a terminal (a pipe, a log file) it prints plain lines and a summary every 25 items. Every line also goes to
// the optional log file with a timestamp.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { format } from 'node:util';

export function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** The text of the live line. Pure, so it can be tested. */
export function barLine({ label = '', done = 0, total = 0, counts = {}, elapsedSec = 0, width = 24 }) {
  const frac = total > 0 ? Math.min(1, done / total) : 0;
  const filled = Math.round(frac * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const per = done > 0 ? elapsedSec / done : 0;
  const eta = done > 0 ? formatEta((total - done) * per) : '--';
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${v}`).join(' ');
  return `${label ? label + ' ' : ''}${bar} ${done}/${total} ${(frac * 100).toFixed(1)}%${top ? ' | ' + top : ''} | ${per ? per.toFixed(1) + 's/item' : '--'} | ETA ${eta}`;
}

export function createProgress({ total, label = '', logFile = '', stream = process.stdout, width = 24 } = {}) {
  const tty = Boolean(stream.isTTY);
  const t0 = Date.now();
  const counts = {};
  let done = 0; let live = false;
  const origLog = console.log; const origErr = console.error;
  if (logFile) { try { mkdirSync(dirname(logFile), { recursive: true }); } catch { /* ignore */ } }
  const toFile = (line) => { if (logFile) { try { appendFileSync(logFile, `${new Date().toISOString()} ${String(line).replace(/\x1b\[[0-9;]*m/g, '')}\n`); } catch { /* ignore */ } } };
  const cols = () => Math.max(40, (stream.columns || 120) - 1);
  const draw = () => { if (!tty) return; live = true; stream.write(`\r\x1b[2K${barLine({ label, done, total, counts, elapsedSec: (Date.now() - t0) / 1000, width }).slice(0, cols())}`); };
  const clear = () => { if (tty && live) { stream.write('\r\x1b[2K'); live = false; } };
  const log = (line) => { clear(); stream.write(`${line}\n`); toFile(line); draw(); };
  const route = (...a) => log(format(...a));
  console.log = route; console.error = route;
  return {
    log,
    /** One item finished; `key` is its outcome (counted in the live line). */
    tick(key) {
      done++; if (key) counts[key] = (counts[key] || 0) + 1;
      if (tty) draw(); else if (done % 25 === 0 || done === total) { stream.write(`${barLine({ label, done, total, counts, elapsedSec: (Date.now() - t0) / 1000 })}\n`); }
    },
    start() { draw(); },
    done(summary = '') {
      clear(); console.log = origLog; console.error = origErr;
      const line = `${label ? label + ': ' : ''}finished ${done}/${total} in ${formatEta((Date.now() - t0) / 1000)} | ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}${summary ? ' | ' + summary : ''}`;
      stream.write(`${line}\n`); toFile(line);
    },
    counts,
  };
}
