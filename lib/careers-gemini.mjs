// lib/careers-gemini.mjs: Gemini for the text questions (domain choice, page check, query planning). No SDK: one fetch per call, so no
// new dependency. Same contract as the Groq clients: invoke([['system', text], ['human', text]]) resolves to
// { parsed, raw: { usage_metadata, response_metadata } } and an HTTP error is thrown with .status and .headers['retry-after'].
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';

/** GEMINI_API_KEYS (comma list), GEMINI_API_KEY, GEMINI_API_KEY_2 .. _9: the environment, then .env files. Never printed. */
export function loadGeminiKeys(dirs) {
  const get = (name) => {
    if (process.env[name]) return process.env[name];
    for (const d of dirs) { const p = join(d, '.env'); const m = existsSync(p) && new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, 'm').exec(readFileSync(p, 'utf-8')); if (m) return m[1].replace(/^['"]|['"]$/g, ''); }
    return '';
  };
  const all = [...get('GEMINI_API_KEYS').split(','), get('GEMINI_API_KEY'), ...[2, 3, 4, 5, 6, 7, 8, 9].map((i) => get(`GEMINI_API_KEY_${i}`))].map((k) => k.trim()).filter(Boolean);
  return [...new Set(all)];
}

export function loadGeminiModel(dirs) {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL.trim();
  for (const d of dirs) { const p = join(d, '.env'); const m = existsSync(p) && /^\s*GEMINI_MODEL\s*=\s*(.+?)\s*$/m.exec(readFileSync(p, 'utf-8')); if (m) return m[1].replace(/^['"]|['"]$/g, ''); }
  return DEFAULT_GEMINI_MODEL;
}

/**
 * Seconds to rest a key after a 429. Gemini says it in the body ("retryDelay": "37s", "Please retry in 37.2s"); a per-day quota
 * has no short delay, so it rests for 6 hours; with nothing to go on, a minute.
 */
export function retryDelaySeconds(bodyText = '', retryAfterHeader = '') {
  const h = Number(retryAfterHeader); if (Number.isFinite(h) && h > 0) return Math.ceil(h);
  const t = String(bodyText);
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(t) || /retry in (\d+(?:\.\d+)?)s/i.exec(t);
  if (m) return Math.ceil(Number(m[1]));
  if (/PerDay|per day|daily/i.test(t)) return 6 * 3600;
  return 60;
}

export function makeGeminiClient({ apiKey, model, schema, fetchImpl = fetch }) {
  const jsonSchema = (() => { try { return z.toJSONSchema(schema); } catch { return null; } })();
  return {
    async invoke(msgs) {
      const system = msgs.filter((m) => m[0] === 'system').map((m) => m[1]).join('\n');
      const human = msgs.filter((m) => m[0] === 'human').map((m) => m[1]).join('\n');
      const body = {
        systemInstruction: { parts: [{ text: `${system}${jsonSchema ? `\nAnswer with one JSON object that matches this JSON schema, and nothing else:\n${JSON.stringify(jsonSchema)}` : ''}` }] },
        contents: [{ role: 'user', parts: [{ text: human }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
      };
      const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`Gemini HTTP ${res.status}`); err.status = res.status;
        err.headers = { 'retry-after': String(res.status === 429 ? retryDelaySeconds(text, res.headers?.get?.('retry-after') || '') : '') };
        throw err;
      }
      let data; try { data = JSON.parse(text); } catch { const err = new Error('Gemini sent a body that is not JSON'); err.status = 502; throw err; }
      const out = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
      let parsed = null; try { parsed = JSON.parse(out); } catch { /* the caller's schema check turns this into "no usable answer" */ }
      return { parsed, raw: { usage_metadata: { input_tokens: data.usageMetadata?.promptTokenCount || 0, output_tokens: data.usageMetadata?.candidatesTokenCount || 0 }, response_metadata: { model_name: data.modelVersion || model } } };
    },
  };
}
