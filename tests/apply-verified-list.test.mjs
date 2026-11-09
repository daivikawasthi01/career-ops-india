import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, norm, plan, applyPlan } from '../tools/apply-verified-list.mjs';

const CSV = 'Company,Careers URL,Hiring system\n"Crunchyroll, LLC",https://job-boards.greenhouse.io/crunchyroll,Greenhouse\nSwiggy,https://jobs.smartrecruiters.com/SWIGGY,SmartRecruiters\nInfosys,https://career.infosys.com/joblist,Own site\n';
const YAML = `tracked_companies:
  - name: Swiggy
    careers_url: https://careers.smartrecruiters.com/swiggy
    api: https://old.example/api
    enabled: false

job_boards: []
`;

test('csv with a quoted comma parses', () => {
  const rows = parseCsv(CSV);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].Company, 'Crunchyroll, LLC');
});

test('names match across suffixes', () => { assert.equal(norm('Crunchyroll, LLC'), norm('Crunchyroll')); });

test('plan and apply: replace, add, watch for sites no provider reads, idempotent', () => {
  const entries = [{ name: 'Swiggy', careers_url: 'https://careers.smartrecruiters.com/swiggy', api: 'x', enabled: false }];
  const items = plan(parseCsv(CSV), entries, (e) => !/infosys/.test(e.careers_url));
  assert.deepEqual(items.map((i) => i.kind), ['add', 'replace', 'add']);
  const out = applyPlan(YAML, items, '2026-11-09');
  assert.match(out, /name: Swiggy\n    careers_url: https:\/\/jobs\.smartrecruiters\.com\/SWIGGY\n    enabled: true/);
  assert.ok(!out.includes('old.example'));
  assert.match(out, /name: "Crunchyroll, LLC"/);
  assert.match(out, /name: Infosys\n[\s\S]*watch: true/);
  assert.ok(out.indexOf('Infosys') < out.indexOf('job_boards:'));
});
