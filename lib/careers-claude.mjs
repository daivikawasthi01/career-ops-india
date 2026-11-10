// lib/careers-claude.mjs: the last-resort text tier. `claude -p` uses the Claude plan you are logged in with, so it costs plan usage, not API
// money. Opt-in (CAREER_OPS_CLAUDE_FALLBACK=1). One short call per question, no tools, no session saved, run from an empty directory so
// no project instructions are loaded. Same contract as the other clients: invoke([['system', text], ['human', text]]).
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export const DEFAULT_CLAUDE_MODEL = 'haiku';
const MAX_PARALLEL = 2; // the plan is shared with you: never more than two of these at once
let running = 0; const waiting = [];
const slot = async () => { if (running >= MAX_PARALLEL) await new Promise((r) => waiting.push(r)); running++; };
const release = () => { running--; waiting.shift()?.(); };

export const claudeEnabled = () => /^(1|true|yes)$/i.test(process.env.CAREER_OPS_CLAUDE_FALLBACK || '');
export const claudeModel = () => process.env.CAREER_OPS_CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL;

/** Run `claude` with the prompt on stdin. Resolves { code, stdout }; never throws. A 90 s limit per call. */
export function runClaude(args, input, { timeoutMs = 90000, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    const cwd = join(tmpdir(), 'career-ops-claude-fallback'); try { mkdirSync(cwd, { recursive: true }); } catch { /* exists */ }
    let out = ''; let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const child = spawnImpl('claude', args, { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish({ code: null, stdout: out, timedOut: true }); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => finish({ code: -1, stdout: out }));
    child.on('close', (code) => finish({ code, stdout: out }));
    try { child.stdin.end(input); } catch { /* closed */ }
  });
}

export function makeClaudeClient({ model = claudeModel(), schema, runImpl = runClaude }) {
  const jsonSchema = (() => { try { return z.toJSONSchema(schema); } catch { return null; } })();
  return {
    async invoke(msgs) {
      const system = msgs.filter((m) => m[0] === 'system').map((m) => m[1]).join('\n');
      const human = msgs.filter((m) => m[0] === 'human').map((m) => m[1]).join('\n');
      const sys = `${system}${jsonSchema ? `\nAnswer with one JSON object that matches this JSON schema, and nothing else. Return the answer object itself (its fields at the top level), never the schema, and no "$schema", "type" or "properties" keys:\n${JSON.stringify(jsonSchema)}` : ''}`;
      const args = ['-p', '--output-format', 'json', '--model', model, '--tools', '', '--no-session-persistence', '--disable-slash-commands', '--setting-sources', '', '--system-prompt', sys];
      await slot();
      let r; try { r = await runImpl(args, human); } finally { release(); }
      const fail = (status, msg, retryAfter = '') => Object.assign(new Error(msg), { status, headers: retryAfter ? { 'retry-after': String(retryAfter) } : {} });
      if (r.timedOut) throw fail(504, 'claude -p timed out');
      let data; try { data = JSON.parse(r.stdout); } catch { throw fail(r.code === -1 ? 503 : 502, 'claude -p gave no JSON'); }
      const text = String(data.result ?? '');
      // A plan limit comes back as an error result that talks about limits and a reset; rest the tier for an hour.
      if (data.is_error || r.code) { throw fail(/limit|usage|quota|reset/i.test(text) ? 429 : 502, `claude -p error: ${text.slice(0, 80)}`, /limit|usage|quota|reset/i.test(text) ? 3600 : ''); }
      const out = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
      let parsed = null; try { parsed = JSON.parse(out); } catch { /* schema check turns this into "no usable answer" */ }
      // The model sometimes returns the schema itself with the answer filled in under "properties": use that object.
      if (parsed && typeof parsed === 'object' && parsed.properties && typeof parsed.properties === 'object' && ('$schema' in parsed || parsed.type === 'object')) parsed = parsed.properties;
      const mu = Object.keys(data.modelUsage || {})[0] || model;
      return { parsed, raw: { usage_metadata: { input_tokens: (data.usage?.input_tokens || 0) + (data.usage?.cache_creation_input_tokens || 0), output_tokens: data.usage?.output_tokens || 0 }, response_metadata: { model_name: mu } } };
    },
  };
}
