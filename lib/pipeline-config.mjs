// lib/pipeline-config.mjs: read config/pipeline.yml, the single source of the India
// entry-level filters, and build the checks every scanner shares.

import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve, relative, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { loadYaml } from './yaml-document.mjs';
import { buildTitleFilter } from '../title-keywords.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PIPELINE_CONFIG_PATH = process.env.CAREER_OPS_PIPELINE_CONFIG || join(HERE, '..', 'config', 'pipeline.yml');

/** Parsed pipeline.yml, or null when the file is absent. A broken file throws: filters must not fail open. */
export function loadPipelineConfig(path = PIPELINE_CONFIG_PATH) {
  if (!existsSync(path)) return null;
  const cfg = loadYaml(readFileSync(path, 'utf-8'));
  if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.title_filter?.positive) || !Array.isArray(cfg.title_filter?.negative)) {
    throw new Error(`${path}: needs title_filter.positive and title_filter.negative lists`);
  }
  return cfg;
}

/** loadPipelineConfig for scanners that cannot run without it. */
export function requirePipelineConfig() {
  const cfg = loadPipelineConfig();
  if (!cfg) throw new Error(`config/pipeline.yml not found at ${PIPELINE_CONFIG_PATH}: it holds the title filters every scanner shares.`);
  return cfg;
}

/** True when the data root was pointed somewhere else (tests, a second profile): that root keeps its own title_filter. */
export function dataRootIsForeign(env = process.env, repoRoot = join(HERE, '..')) {
  const root = env.CAREER_OPS_ROOT;
  return Boolean(root) && resolve(root) !== resolve(repoRoot) && !env.CAREER_OPS_PIPELINE_CONFIG;
}

/** True when CAREER_OPS_ROOT points somewhere that is not inside the repository checkout. */
export function dataRootOutsideRepo(env = process.env, repoRoot = join(HERE, '..')) {
  const root = env.CAREER_OPS_ROOT;
  if (!root) return false;
  const rel = relative(resolve(repoRoot), resolve(root));
  return rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel);
}

const announced = new Set();
/** Print each distinct notice once per process, on stderr so JSON on stdout stays clean. */
function announce(key, message, log) {
  if (announced.has(key)) return;
  announced.add(key);
  log(message);
}
/** Test hook: forget what was already printed. */
export function resetPipelineConfigNotices() { announced.clear(); }

/**
 * Startup warning: a data root outside the repo means this run reads another profile's files,
 * and (unless CAREER_OPS_PIPELINE_CONFIG is set) config/pipeline.yml does not apply to it.
 */
export function warnIfDataRootOutsideRepo({ env = process.env, repoRoot = join(HERE, '..'), log = console.error } = {}) {
  if (!dataRootOutsideRepo(env, repoRoot)) return false;
  announce('root', `[career-ops] WARNING: CAREER_OPS_ROOT=${resolve(env.CAREER_OPS_ROOT)} is outside the repository (${resolve(repoRoot)}). `
    + 'This run reads that directory\'s data, not this checkout\'s.', log);
  return true;
}

/**
 * Make portals.yml's title_filter (and title_filter_full) yield to pipeline.yml. Returns the same object.
 * When the overlay is skipped it says so once on stderr, with the reason, so a scan that quietly used
 * a different title_filter is visible.
 */
export function applyPipelineConfig(portalsConfig, pipeline = loadPipelineConfig(), { env = process.env, log = console.error } = {}) {
  warnIfDataRootOutsideRepo({ env, log });
  if (dataRootIsForeign(env)) {
    announce('skip-foreign',
      `[career-ops] pipeline overlay SKIPPED: CAREER_OPS_ROOT=${resolve(env.CAREER_OPS_ROOT)} is not this repository, so portals.yml keeps its own title_filter. `
      + 'Set CAREER_OPS_PIPELINE_CONFIG=<path to config/pipeline.yml> to apply it.', log);
    return portalsConfig;
  }
  if (!pipeline) {
    announce('skip-missing', `[career-ops] pipeline overlay SKIPPED: ${PIPELINE_CONFIG_PATH} not found, so portals.yml keeps its own title_filter.`, log);
    return portalsConfig;
  }
  if (!portalsConfig || typeof portalsConfig !== 'object') return portalsConfig;
  portalsConfig.title_filter = pipeline.title_filter;
  delete portalsConfig.title_filter_full;
  return portalsConfig;
}

const asYears = (list) => (Array.isArray(list) ? list.map(String) : []);

/**
 * Batch check: a text naming batch years must name at least one accepted year.
 * `batchYearsOf` is passed in (scan-freehire owns the regex) to keep this module free of scanner imports.
 */
export function batchAccepted(text, acceptedYears, batchYearsOf) {
  const accepted = asYears(acceptedYears);
  if (!accepted.length) return true;
  const named = batchYearsOf(text);
  return named.length === 0 || named.some((y) => accepted.includes(String(y)));
}

/**
 * One title check for all surfaces: title filter, then batch year.
 * @returns {(title: string) => {keep: boolean, reason?: string}}
 */
export function buildTitleCheck(pipeline, batchYearsOf) {
  const titleOk = buildTitleFilter(pipeline.title_filter);
  return (title) => {
    if (!titleOk(title)) return { keep: false, reason: 'title_filter' };
    if (!batchAccepted(title, pipeline.batch_years, batchYearsOf)) return { keep: false, reason: 'batch_year' };
    return { keep: true };
  };
}
