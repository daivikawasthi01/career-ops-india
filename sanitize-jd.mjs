#!/usr/bin/env node
// sanitize-jd.mjs FILE: rewrite a fetched job description in place, stripped, capped and delimited
// (lib/untrusted.mjs). Called by batch/batch-runner.sh just before the worker is told to read the file.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { wrapUntrusted } from './lib/untrusted.mjs';
import { requirePipelineConfig } from './lib/pipeline-config.mjs';

const file = process.argv[2];
if (!file || !existsSync(file)) process.exit(0);
let max = 12000;
try { max = requirePipelineConfig().jd_hygiene?.max_chars ?? max; } catch { /* config is optional here */ }
const raw = readFileSync(file, 'utf-8');
const out = wrapUntrusted(raw, { maxChars: max });
if (out !== raw) writeFileSync(file, out);
