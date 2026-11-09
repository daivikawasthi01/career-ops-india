#!/usr/bin/env node
/**
 * check-gemini.mjs: confirm the Gemini keys in .env and the model name work. Prints key numbers, never the keys.
 *   node tools/check-gemini.mjs
 * For each key: does the model exist for it, and does one tiny call answer? A wrong model name lists the model names that contain "flash".
 */
import { join, dirname } from 'node:path';
import { z } from 'zod';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { loadGeminiKeys, loadGeminiModel, makeGeminiClient } from '../lib/careers-gemini.mjs';

const REPO = join(dirname(new URL(import.meta.url).pathname), '..');
const dirs = [process.env.CAREER_OPS_ENV_DIR, getCareerOpsRoot(), REPO].filter(Boolean);
const keys = loadGeminiKeys(dirs); const model = loadGeminiModel(dirs);
if (!keys.length) { console.log('No Gemini keys found. Add GEMINI_API_KEY, GEMINI_API_KEY_2 ... GEMINI_API_KEY_9 (or GEMINI_API_KEYS=a,b,c) to the .env file.'); process.exit(1); }
console.log(`model: ${model}, ${keys.length} key(s)`);
let bad = 0;
for (const [i, key] of keys.entries()) {
  let line = `key ${i + 1}: `;
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
    if (!r.ok) { line += `cannot list models (HTTP ${r.status})`; bad++; console.log(line); continue; }
    const names = ((await r.json()).models || []).map((m) => String(m.name).replace(/^models\//, ''));
    if (!names.includes(model)) { line += `model "${model}" not found. Models with "flash": ${names.filter((n) => /flash/i.test(n)).slice(0, 12).join(', ') || 'none'}`; bad++; console.log(line); continue; }
    const out = await makeGeminiClient({ apiKey: key, model, schema: z.object({ ok: z.boolean() }) }).invoke([['system', 'Reply with {"ok": true}.'], ['human', 'ping']]);
    line += out.parsed?.ok === true ? `ok (${out.raw.usage_metadata.input_tokens}+${out.raw.usage_metadata.output_tokens} tokens)` : 'answered, but not the expected JSON';
    if (out.parsed?.ok !== true) bad++;
  } catch (e) { line += `failed (HTTP ${e.status ?? '?'}${e.headers?.['retry-after'] ? ', retry after ' + e.headers['retry-after'] + 's' : ''})`; bad++; }
  console.log(line);
}
process.exit(bad ? 1 : 0);
