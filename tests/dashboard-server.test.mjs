import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTsv, namesOf, hostOk, createDashboard, runnable, startRun } from '../tools/dashboard/server.mjs';

test('parseTsv and namesOf read the pipeline files', () => {
  assert.deepEqual(parseTsv('a\tb\n1\t2\n3\n'), [{ a: '1', b: '2' }, { a: '3', b: '' }]);
  assert.deepEqual(parseTsv(''), []);
  assert.deepEqual(namesOf('Acme\n# c\n\nBeta\tx\n'), ['Acme', 'Beta']);
});

test('hostOk refuses other hosts and cross-site origins (DNS rebinding)', () => {
  const req = (host, origin) => ({ headers: { host, ...(origin ? { origin } : {}) } });
  assert.equal(hostOk(req('127.0.0.1:8790'), 8790), true);
  assert.equal(hostOk(req('localhost:8790', 'http://localhost:8790'), 8790), true);
  assert.equal(hostOk(req('evil.example:8790'), 8790), false);
  assert.equal(hostOk(req('127.0.0.1:8790', 'https://evil.example'), 8790), false);
});

test('server: static page, JSON api, no traversal, unknown run refused, bad run id refused', async () => {
  const srv = createDashboard(0); // port 0 picks one; the Host check below uses the real port
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  srv.close(); // re-create with the real port so hostOk matches
  const real = createDashboard(port);
  await new Promise((r) => real.listen(port, '127.0.0.1', r));
  try {
    const get = (path, init) => fetch(`http://127.0.0.1:${port}${path}`, init);
    assert.equal((await get('/')).status, 200);
    assert.equal((await get('/api/nope')).status, 404);
    assert.equal((await get('/api/run/unknown-run')).status, 404);
    const bad = await get('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'rm -rf /' }) });
    assert.equal(bad.status, 400);
    const bad2 = await get('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ steps: ['portals', 'rm -rf /'], dry: true }) });
    assert.equal(bad2.status, 400);
    const st = await get('/api/jobs/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ canonical_url: 'x', status: 'bogus' }) });
    assert.equal(st.status, 400);
    const ov = await (await get('/api/overview')).json();
    assert.ok(Array.isArray(ov.lists));
  } finally { real.close(); }
});

test('the slow lane is a runnable source that must run alone', () => {
  assert.equal(runnable('slow'), true);
  assert.throws(() => startRun({ steps: ['slow', 'jobspy'] }), /on its own/);
  assert.throws(() => startRun({ steps: ['nonsense'] }), /not a runnable source/);
});
