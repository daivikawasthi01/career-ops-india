import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDirectory, atsOf } from '../tools/import-careers-directory.mjs';

test('parseDirectory keeps external company links, drops own-site and generic ones, dedups by name', () => {
  const html = `<a href="https://acme.keka.com/careers">Acme &amp; Co</a><a href="https://careersat.tech/jobs">Jobs</a>
  <a href="https://x.com/c">Read more</a><a href="https://acme.example/careers">acme &amp; co</a><a href="/rel">Rel</a><a href="https://b.io/jobs">Beta</a>`;
  const r = parseDirectory(html);
  assert.deepEqual(r.map((x) => x.company), ['Acme & Co', 'Beta']);
});
test('atsOf recognises Indian and global ATS hosts', () => {
  assert.equal(atsOf('https://acme.keka.com/careers'), 'keka');
  assert.equal(atsOf('https://x.darwinbox.in/ms/candidatev2/main/careers'), 'darwinbox');
  assert.equal(atsOf('https://boards.greenhouse.io/x'), 'greenhouse');
  assert.equal(atsOf('https://www.acme.com/careers'), 'custom');
  assert.equal(atsOf('nonsense'), 'unknown');
});
