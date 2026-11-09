#!/usr/bin/env node
/**
 * apply-careers-review.mjs: apply the careers pages you ticked in the review dashboard.
 *
 *   node tools/apply-careers-review.mjs                     # preview only: prints what would change
 *   node tools/apply-careers-review.mjs --write             # weekly_links.txt additions only (custom pages)
 *   node tools/apply-careers-review.mjs --write --add-new   # also add ticked ATS boards for companies not in portals.yml
 *   node tools/apply-careers-review.mjs --write --replace-boards   # also point existing entries at the ticked board
 *
 * Only rows you ticked are used. Crossed and unreviewed rows are never applied. Every write is preceded by a timestamped
 * backup and refuses to run while discover-ats is running.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMainModule } from '../lib/is-main-module.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { loadYaml } from '../lib/yaml-document.mjs';
import { backupFile, atomicWrite, discoverIsRunning } from '../lib/portals-edit.mjs';
import { planChanges, addEntries, replaceBoards, addWeekly } from '../lib/careers-apply.mjs';
import { parseTsv } from './careers-review.mjs';

const ROOT = getCareerOpsRoot();
const PORTALS = process.env.CAREER_OPS_PORTALS || join(ROOT, 'portals.yml');
const WEEKLY = process.env.CAREER_OPS_WEEKLY || join(ROOT, 'tools', 'weekly_links.txt');
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write'); const addNew = argv.includes('--add-new'); const replace = argv.includes('--replace-boards');
  const review = JSON.parse(read(process.env.CAREER_OPS_REVIEW || join(ROOT, 'data', 'careers-review.json')) || '{}');
  const rows = parseTsv(read(process.env.CAREER_OPS_DISCOVERY || join(ROOT, 'data', 'careers-discovery.tsv')) || 'company\n');
  const portalsText = read(PORTALS); const weeklyText = read(WEEKLY);
  const entries = (loadYaml(portalsText) || {}).tracked_companies || [];
  const plan = planChanges({ review, rows, entries, weeklyText });
  const by = (k) => plan.filter((p) => p.kind === k);
  const ticked = Object.values(review).filter((v) => v.decision === 'ok').length; const crossed = Object.values(review).filter((v) => v.decision === 'bad').length;
  console.log(`Ticked ${ticked}, crossed ${crossed} (crossed rows are ignored).`);
  for (const [k, label] of [['same', 'already correct'], ['weekly', 'custom pages -> weekly_links.txt'], ['add-new', 'new ATS boards (need --add-new)'], ['conflict', 'different board in portals.yml (need --replace-boards)'], ['skip', 'unusable']]) {
    console.log(`\n${label}: ${by(k).length}`);
    if (k !== 'same') for (const p of by(k)) console.log(`  ${p.company} | ${p.url}${p.current ? `  (now ${p.current})` : ''}`);
  }
  if (!write) { console.log('\nPreview only. Nothing written.'); return 0; }
  if (discoverIsRunning()) { console.error('discover-ats is running; try again when it has finished.'); return 1; }
  const doAdd = addNew ? by('add-new') : []; const doRep = replace ? by('conflict') : []; const doWeekly = by('weekly');
  if (doAdd.length || doRep.length) {
    console.log(`\nportals.yml backup: ${backupFile(PORTALS)}`);
    let t = portalsText;
    if (doRep.length) t = replaceBoards(t, doRep).text;
    if (doAdd.length) t = addEntries(t, doAdd).text;
    atomicWrite(PORTALS, t);
  }
  if (doWeekly.length) { console.log(`weekly_links.txt backup: ${backupFile(WEEKLY)}`); atomicWrite(WEEKLY, addWeekly(weeklyText, doWeekly)); }
  console.log(`\nWritten: ${doAdd.length} new boards, ${doRep.length} replaced boards, ${doWeekly.length} weekly links.`);
  return 0;
}
if (isMainModule(import.meta.url)) process.exit(main());
