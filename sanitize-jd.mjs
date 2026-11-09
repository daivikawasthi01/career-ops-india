#!/usr/bin/env node
// sanitize-jd.mjs FILE: rewrite a fetched job description in place, stripped, capped and delimited
// (lib/untrusted.mjs). Called by batch/batch-runner.sh just before the worker is told to read the file.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { wrapJobText } from './lib/untrusted-jd.mjs';

const file = process.argv[2];
if (!file || !existsSync(file)) process.exit(0);
const raw = readFileSync(file, 'utf-8');
const out = wrapJobText(raw);
if (out !== raw) writeFileSync(file, out);
