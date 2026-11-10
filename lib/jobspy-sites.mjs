/**
 * The JobSpy site table (config/pipeline.yml jobspy.sites): which sites a default run uses, which only the slow lane uses,
 * and each site's call budget and pause. One reader so no caller keeps its own list of sites.
 */
const names = (sites, flag) => Object.keys(sites).filter((n) => sites[n]?.[flag]);

/** @param {Record<string, {first_pass?: boolean, slow?: boolean, budget?: number, jitter_seconds?: number[]}>} [sites] */
export function jobspySites(sites = {}) {
  const pick = (names_, key) => Object.fromEntries(names_.filter((n) => sites[n]?.[key] !== undefined).map((n) => [n, sites[n][key]]));
  const all = Object.keys(sites);
  return { all, firstPass: names(sites, 'first_pass'), slow: names(sites, 'slow'), budget: pick(all, 'budget'), jitter: pick(all, 'jitter_seconds') };
}
