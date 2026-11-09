// The India location filter, pinned by tests/india-location.golden.tsv.
//  1. A fixture allow list shows the rules: alternate spellings pass, ambiguous names only with a state or country.
//  2. The same rows run against the data root's own portals.yml when it has an India allow list, so a later edit
//     that drops a city fails here. Skipped when there is none (CI, a clean checkout).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadYaml } from '../lib/yaml-document.mjs';
import { buildLocationFilter } from '../scan.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const rows = readFileSync(join(HERE, 'india-location.golden.tsv'), 'utf-8').split('\n')
  .filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t'));

const FIXTURE = {
  always_allow: ['India'],
  allow: ['India', 'Bengaluru', 'Mumbai', 'Pan India', 'Bhubaneswar', 'Bhubaneshwar', 'Mysuru', 'Mysore', 'Visakhapatnam', 'Vizag',
    'Nashik', 'Bhopal', 'Ranchi', 'Kozhikode', 'Calicut', 'Thane, Maharashtra', 'Thane, MH', 'Surat, Gujarat', 'Surat, GJ', 'Patna, Bihar', 'Patna, BR'],
};

function check(filterConfig) {
  const lf = buildLocationFilter(filterConfig);
  const wrong = rows.filter(([loc, want]) => (lf(loc, '', 'Software Engineer') ? 'pass' : 'fail') !== want);
  assert.deepEqual(wrong, [], `golden rows that disagree: ${JSON.stringify(wrong)}`);
}

test('golden rows hold for the fixture allow list', () => check(FIXTURE));

test('golden rows hold for this data root\'s portals.yml, when it has an India allow list', (t) => {
  const path = process.env.CAREER_OPS_PORTALS || join(getCareerOpsRoot(), 'portals.yml');
  const cfg = existsSync(path) ? loadYaml(readFileSync(path, 'utf-8')) : null;
  const lf = cfg?.location_filter;
  if (!lf || !(lf.allow || []).some((a) => /^bengaluru$/i.test(a))) { t.skip('no India allow list in this data root'); return; }
  check(lf);
});
