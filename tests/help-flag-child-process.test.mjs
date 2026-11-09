// Spawns each portal-maintenance CLI with --help and -h as a real child process.
// The static ratchet in help-flag-handled.test.mjs only greps for the flag; this
// proves the flag works: exit 0, usage text on stdout, nothing written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = ['audit-portals.mjs', 'audit-helper.mjs', 'board-india-check.mjs', 'import-jobradar.mjs'];

for (const script of SCRIPTS) {
  for (const flag of ['--help', '-h']) {
    test(`${script} ${flag} prints usage and exits 0 without side effects`, () => {
      // Pinned, empty data root: a script that ignored the flag would find nothing
      // to read and would fail or write into this directory, not the real one.
      const sandbox = mkdtempSync(join(tmpdir(), 'co-help-child-'));
      try {
        const r = spawnSync(process.execPath, [join(ROOT, script), flag], {
          encoding: 'utf-8',
          cwd: sandbox,
          timeout: 15000,
          env: { ...process.env, CAREER_OPS_ROOT: sandbox, CAREER_OPS_PORTALS: join(sandbox, 'missing-portals.yml') },
        });
        assert.equal(r.status, 0, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
        assert.match(r.stdout, /usage/i, `no usage text on stdout: ${r.stdout}`);
        assert.deepEqual(readdirSync(sandbox), [], 'help must not create files');
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    });
  }
}
