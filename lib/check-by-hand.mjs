// lib/check-by-hand.mjs: data/check-by-hand.txt is a worklist for a person. Several tools add to it, each in
// its own marked section, so one tool re-running never wipes another's findings.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const open = (name) => `# >>> ${name}`;
const close = (name) => `# <<< ${name}`;

/** Replace (or append) the section called `name` with `lines`. An empty `lines` removes the section. */
export function writeSection(path, name, lines) {
  const text = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const re = new RegExp(`${open(name)}\\n[\\s\\S]*?${close(name)}\\n?`);
  const block = lines.length ? `${open(name)}\n${lines.join('\n')}\n${close(name)}\n` : '';
  const next = re.test(text) ? text.replace(re, block) : text + (text && !text.endsWith('\n') ? '\n' : '') + block;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  return next;
}

/** Lines of one section, without the markers. */
export function readSection(path, name) {
  if (!existsSync(path)) return [];
  const m = new RegExp(`${open(name)}\\n([\\s\\S]*?)${close(name)}`).exec(readFileSync(path, 'utf-8'));
  return m ? m[1].split('\n').filter(Boolean) : [];
}
