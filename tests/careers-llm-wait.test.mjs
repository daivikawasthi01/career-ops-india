import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLlm } from '../lib/careers-llm.mjs';

const e429 = (secs) => Object.assign(new Error('429'), { status: 429, headers: { 'retry-after': String(secs) } });

// One Groq key, no Gemini, no second model. The key is limited until t0 + 30 s; the clock only moves when the code sleeps.
function setup(maxWaitMs) {
  let t = 1_000_000; const limitUntil = t + 30000; let calls = 0; const slept = [];
  const makeClient = () => ({ invoke: async () => { calls++; if (t < limitUntil) throw e429(30); return { parsed: { domain: null, evidence_quote: '', confidence: 'low' }, raw: { usage_metadata: { input_tokens: 1, output_tokens: 1 }, response_metadata: { model_name: 'm' } } }; } });
  const sleepFn = async (ms) => { slept.push(ms); t += ms; };
  return { slept, calls: () => calls, make: () => makeLlm({ keys: ['g1'], model: 'groq:p', fallback: '', now: () => t, makeClient, maxWaitMs, sleepFn }) };
}

test('with a wait budget, a rate-limited question sleeps until the key is free and is then answered', async () => {
  const s = setup(60000); const llm = await s.make();
  const r = await llm.chooseDomain({ profile: { name: 'X' }, candidates: [] });
  assert.equal(s.slept.length, 1);
  assert.ok(s.slept[0] >= 30000 && s.slept[0] <= 31000, `slept ${s.slept[0]}`);
  assert.equal(s.calls(), 2);
  assert.notEqual(r.raw, 'error: 429', 'the second call got through');
});

test('without a wait budget (default), a rate-limited question fails at once as before', async () => {
  const s = setup(0); const llm = await s.make();
  const r = await llm.chooseDomain({ profile: { name: 'X' }, candidates: [] });
  assert.equal(r.value, null);
  assert.equal(s.slept.length, 0);
  assert.equal(s.calls(), 1);
});

test('a limit longer than the wait budget is not waited out (the run halts with the reset time instead)', async () => {
  const s = setup(10000); const llm = await s.make();
  const r = await llm.chooseDomain({ profile: { name: 'X' }, candidates: [] });
  assert.equal(r.value, null);
  assert.equal(s.slept.length, 0);
});
