#!/usr/bin/env node
/**
 * board-jobs.mjs: list the postings on named companies' resolved boards (portals.yml entries), as JSON.
 *
 *   node board-jobs.mjs --companies names.json     # names.json: ["Razorpay", "Acme"]
 *
 * Prints {"<name>": [{title, url, location}] | {"error": "..."}} on stdout. Read-only, nothing is written.
 * Used by tools/confirm.py to mark aggregator rows employer-confirmed.
 */
import { readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { loadYaml } from './lib/yaml-document.mjs';
import { loadProviders, resolveProvider } from './providers/_registry.mjs';
import { makeHttpCtx } from './providers/_http.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || join(HERE, 'portals.yml');
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

async function main() {
  const i = process.argv.indexOf('--companies');
  const file = i >= 0 ? process.argv[i + 1] : null;
  if (!file || !existsSync(file)) { console.error('usage: node board-jobs.mjs --companies names.json'); process.exit(1); }
  const names = JSON.parse(readFileSync(file, 'utf-8'));
  const config = loadYaml(readFileSync(PORTALS_PATH, 'utf-8')) || {};
  const entries = (config.tracked_companies || []).filter((e) => e && e.enabled !== false && typeof e.name === 'string');
  const byName = new Map(entries.map((e) => [norm(e.name), e]));
  const providers = await loadProviders(resolve(HERE, 'providers'));
  const ctx = makeHttpCtx();
  const out = {};
  for (const name of names) {
    const entry = byName.get(norm(name));
    if (!entry) { out[name] = { error: 'no board' }; continue; }
    const resolved = resolveProvider(entry, providers);
    if (!resolved || resolved.error) { out[name] = { error: 'no provider' }; continue; }
    try {
      const jobs = await resolved.provider.fetch({ ...entry }, ctx);
      out[name] = (Array.isArray(jobs) ? jobs : []).map((j) => ({ title: j.title, url: j.url, location: j.location || '' }));
    } catch (err) {
      out[name] = { error: String(err?.message || err).slice(0, 120) };
    }
  }
  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => { console.error(err?.stack || err); process.exit(1); });
