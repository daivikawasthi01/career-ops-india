import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { loadGeminiKeys, loadGeminiModel, retryDelaySeconds, makeGeminiClient, DEFAULT_GEMINI_MODEL } from '../lib/careers-gemini.mjs';
import { makeLlm } from '../lib/careers-llm.mjs';

test('Gemini keys and model come from the same style of .env variables as the Groq ones, deduplicated', () => {
  const d = mkdtempSync(join(tmpdir(), 'gem-'));
  writeFileSync(join(d, '.env'), 'GEMINI_API_KEY=k1\nGEMINI_API_KEY_1=k5\nGEMINI_API_KEY_12=k6\nGEMINI_API_KEY_2=k2\nGEMINI_API_KEY_3="k3"\nGEMINI_API_KEYS=k1,k4\nGEMINI_MODEL=gemini-x\n');
  const saved = { a: process.env.GEMINI_API_KEY, m: process.env.GEMINI_MODEL }; delete process.env.GEMINI_API_KEY; delete process.env.GEMINI_MODEL;
  try {
    assert.deepEqual(loadGeminiKeys([d]).sort(), ['k1', 'k2', 'k3', 'k4', 'k5', 'k6']);
    assert.equal(loadGeminiModel([d]), 'gemini-x');
    assert.equal(loadGeminiModel([mkdtempSync(join(tmpdir(), 'gem-'))]), DEFAULT_GEMINI_MODEL);
  } finally { if (saved.a) process.env.GEMINI_API_KEY = saved.a; if (saved.m) process.env.GEMINI_MODEL = saved.m; }
});

test('retry delay is read from the body, a per-day quota rests for hours, otherwise a minute', () => {
  assert.equal(retryDelaySeconds('{"error":{"details":[{"retryDelay":"37s"}]}}'), 37);
  assert.equal(retryDelaySeconds('Please retry in 12.3s.'), 13);
  assert.equal(retryDelaySeconds('Quota exceeded for metric ...PerDay...'), 6 * 3600);
  assert.equal(retryDelaySeconds('nothing useful'), 60);
  assert.equal(retryDelaySeconds('x', '45'), 45);
});

const schema = z.object({ ok: z.boolean() });
const fakeFetch = (status, body, headers = {}) => async () => ({ ok: status < 400, status, headers: { get: (k) => headers[k] }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

test('the Gemini client parses the JSON answer and reports tokens', async () => {
  const c = makeGeminiClient({ apiKey: 'k', model: 'm', schema, fetchImpl: fakeFetch(200, { candidates: [{ content: { parts: [{ text: '```json\n{"ok":true}\n```' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 }, modelVersion: 'm-001' }) });
  const r = await c.invoke([['system', 's'], ['human', 'h']]);
  assert.deepEqual(r.parsed, { ok: true });
  assert.equal(r.raw.usage_metadata.input_tokens, 10);
  assert.equal(r.raw.response_metadata.model_name, 'm-001');
});

test('a 429 from Gemini carries its retry delay, and the key is never put in the URL', async () => {
  let seenUrl = ''; let seenHeaders;
  const c = makeGeminiClient({ apiKey: 'SECRET', model: 'm', schema, fetchImpl: async (url, init) => { seenUrl = url; seenHeaders = init.headers; return { ok: false, status: 429, headers: { get: () => '' }, text: async () => '{"retryDelay":"20s"}' }; } });
  await assert.rejects(() => c.invoke([['human', 'h']]), (e) => e.status === 429 && e.headers['retry-after'] === '20');
  assert.ok(!seenUrl.includes('SECRET'));
  assert.equal(seenHeaders['x-goog-api-key'], 'SECRET');
});

// A fake client per (provider, key): answers, or throws what the real one would.
const fake = (behaviour) => ({ provider, key, id }) => ({ invoke: async () => { const b = behaviour[`${provider}:${key}`]; if (b instanceof Error) throw b; return { parsed: { ok: true }, raw: { usage_metadata: { input_tokens: 5, output_tokens: 1 }, response_metadata: { model_name: b || id } } }; } });
const e429 = (secs) => Object.assign(new Error('429'), { status: 429, headers: { 'retry-after': String(secs) } });

test('tiers: Groq primary, then Gemini, then the Groq fallback; Gemini answers count as fallback answers', async () => {
  const llm = await makeLlm({ keys: ['g1'], model: 'groq:p', fallback: 'groq:f', geminiKeys: ['m1'], geminiModel: 'gem', makeClient: fake({ 'groq:g1': e429(5000), 'gemini:m1': 'gem-ver' }) });
  const r = await llm.chooseDomain({ profile: { name: 'X' }, candidates: [] }).catch(() => null);
  assert.ok(r, 'answered');
  assert.equal(r.model, 'gemini:gem-ver'); assert.equal(r.fallback, true);
  assert.equal(llm.limitedUntil(), 0, 'Gemini and the fallback model can still answer');
});

test('when every key on every text tier is limited, limitedUntil is the first reset; vision never uses Gemini', async () => {
  const t0 = 1_000_000;
  const llm = await makeLlm({ keys: ['g1'], model: 'groq:p', fallback: 'groq:f', geminiKeys: ['m1'], geminiModel: 'gem', now: () => t0, makeClient: fake({ 'groq:g1': e429(100), 'gemini:m1': e429(40) }) });
  const r = await llm.chooseDomain({ profile: { name: 'X' }, candidates: [] });
  assert.equal(r.value, null);
  assert.equal(llm.limitedUntil(), t0 + 40000);
  const v = await llm.seeScreenshot({ company: 'X', query: 'q', imageB64: 'AAAA' });
  assert.equal(v.value, null, 'vision tried Groq only and is limited');
});

import { makeClaudeClient } from '../lib/careers-claude.mjs';
const claudeJson = (o) => JSON.stringify(o);
test('claude -p client: parses the result, reports tokens, runs with no tools and from a plain prompt on stdin', async () => {
  let seen;
  const c = makeClaudeClient({ model: 'haiku', schema, runImpl: async (args, input) => { seen = { args, input }; return { code: 0, stdout: claudeJson({ result: '{"ok": true}', is_error: false, usage: { input_tokens: 2, cache_creation_input_tokens: 900, output_tokens: 9 }, modelUsage: { 'claude-haiku-5-5': {} } }) }; } });
  const r = await c.invoke([['system', 's'], ['human', 'hello']]);
  assert.deepEqual(r.parsed, { ok: true });
  assert.equal(r.raw.usage_metadata.input_tokens, 902);
  assert.equal(r.raw.response_metadata.model_name, 'claude-haiku-5-5');
  assert.equal(seen.input, 'hello');
  assert.ok(seen.args.includes('--tools') && seen.args[seen.args.indexOf('--tools') + 1] === '');
  assert.ok(seen.args.includes('--no-session-persistence'));
});

test('claude -p client: a plan limit becomes a 429 that rests for an hour, a timeout a 504, garbage a 502', async () => {
  const mk = (res) => makeClaudeClient({ model: 'haiku', schema, runImpl: async () => res });
  await assert.rejects(() => mk({ code: 1, stdout: claudeJson({ is_error: true, result: 'You have reached your usage limit. It resets at 5pm.' }) }).invoke([['human', 'h']]), (e) => e.status === 429 && e.headers['retry-after'] === '3600');
  await assert.rejects(() => mk({ code: null, stdout: '', timedOut: true }).invoke([['human', 'h']]), (e) => e.status === 504);
  await assert.rejects(() => mk({ code: 0, stdout: 'not json' }).invoke([['human', 'h']]), (e) => e.status === 502);
});

test('the claude tier is the very last: used only when Groq and Gemini are all limited, and counts toward limitedUntil', async () => {
  const t0 = 5_000_000;
  const mkc = ({ provider, key }) => ({ invoke: async () => { if (provider === 'claude') return { parsed: { ok: true }, raw: { response_metadata: { model_name: 'claude-haiku-5-5' } } }; throw e429(10000); } });
  const llm = await makeLlm({ keys: ['g1'], model: 'groq:p', fallback: 'groq:f', geminiKeys: ['m1'], geminiModel: 'gem', claudeModel: 'haiku', now: () => t0, makeClient: mkc });
  const r = await llm.chooseDomain({ profile: { name: 'X' }, candidates: [] });
  assert.equal(r.model, 'claude:claude-haiku-5-5'); assert.equal(r.fallback, true);
  assert.equal(llm.limitedUntil(), 0, 'claude can still answer');
  const off = await makeLlm({ keys: ['g1'], model: 'groq:p', fallback: 'groq:f', now: () => t0, makeClient: mkc });
  assert.equal((await off.chooseDomain({ profile: { name: 'X' }, candidates: [] })).value, null);
  assert.ok(off.limitedUntil() > t0);
});
