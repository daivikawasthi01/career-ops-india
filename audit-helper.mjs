#!/usr/bin/env node
// audit-helper.mjs: read-only answers for tools/audit_missed.py and tools/weekly_report.py.
//   node audit-helper.mjs explain "<title>"   which title rule blocks it (config/pipeline.yml), as JSON
//   node audit-helper.mjs tracked             names and board URLs of enabled tracked_companies, as JSON
import { isMainModule } from './lib/is-main-module.mjs';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadYaml } from './lib/yaml-document.mjs';
import { buildTitleFilter } from './title-keywords.mjs';
import { requirePipelineConfig } from './lib/pipeline-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || join(HERE, 'portals.yml');

/** Why the title rules keep or drop a title. Pure: pass the title_filter block. */
export function explainTitle(title, tf) {
  const full = buildTitleFilter(tf);
  if (full(title)) return { keep: true, rule: null };
  for (const term of tf.negative || []) {
    const only = buildTitleFilter({ positive: [], negative: [term], protect: tf.protect });
    if (!only(title)) return { keep: false, rule: `negative: ${term}` };
  }
  return { keep: false, rule: 'no positive keyword matched' };
}

function tracked() {
  if (!existsSync(PORTALS_PATH)) return [];
  const cfg = loadYaml(readFileSync(PORTALS_PATH, 'utf-8')) || {};
  return (cfg.tracked_companies || [])
    .filter((e) => e && e.enabled !== false && typeof e.name === 'string')
    .map((e) => ({ name: e.name, url: e.careers_url || e.api || '' }));
}

if (isMainModule(import.meta.url)) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'explain') console.log(JSON.stringify(explainTitle(arg || '', requirePipelineConfig().title_filter)));
  else if (cmd === 'tracked') console.log(JSON.stringify(tracked()));
  else { console.error('usage: audit-helper.mjs explain "<title>" | tracked'); process.exit(1); }
}
