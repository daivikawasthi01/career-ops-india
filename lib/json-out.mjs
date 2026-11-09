// lib/json-out.mjs: the optional file path after a bare-or-valued `--json` flag.
//   --json            receipt on stdout (unchanged)
//   --json out.json   offers also written to out.json, atomically
import { writeFileSync, renameSync, mkdirSync } from 'fs';
import { dirname } from 'path';

/** Path following --json, or null when --json is bare, absent, or followed by another flag. */
export function jsonPathArg(args) {
  const eq = args.find((a) => a.startsWith('--json='));
  if (eq) return eq.slice('--json='.length) || null;
  const i = args.indexOf('--json');
  const next = i >= 0 ? args[i + 1] : undefined;
  return next && !next.startsWith('-') ? next : null;
}

/** Normalise an offer to the fields downstream tools read. */
export function plainOffer(o, source) {
  return {
    url: o.url,
    title: o.title ?? '',
    company: o.company ?? '',
    location: o.location ?? '',
    source: source || o.source || '',
    ...(o.postedAt ? { posted: new Date(o.postedAt).toISOString().slice(0, 10) } : {}),
  };
}

export function writeJsonFile(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}
