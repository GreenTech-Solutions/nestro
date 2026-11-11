import * as assert from 'assert';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAuditOutcome } from '../utils/auditClient';
import { runBoundedProcess } from '../utils/processRunner';
import { removeFixturePath } from './fixtures';

/** Bounds a real npm start, including a cold Windows shell and one registry round trip. */
const PACKAGE_MANAGER_TIMEOUT_MS = 60000;

suite('Package manager launch (real npm)', function () {
  this.timeout(PACKAGE_MANAGER_TIMEOUT_MS);

  let fixtureDir: string;

  suiteSetup(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), 'nestro-spawn-'));
    const manifest = { name: 'nestro-spawn-fixture', version: '1.0.0', private: true };
    const lockfile = {
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: manifest.name, version: manifest.version } },
    };
    await writeFile(join(fixtureDir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8');
    await writeFile(join(fixtureDir, 'package-lock.json'), `${JSON.stringify(lockfile, undefined, 2)}\n`, 'utf8');
  });

  suiteTeardown(async () => {
    await removeFixturePath(fixtureDir);
  });

  test('starts the npm launcher and reads its output instead of failing to spawn', async () => {
    const outcome = await runBoundedProcess('npm', ['--version'], {
      cwd: fixtureDir,
      timeoutMs: PACKAGE_MANAGER_TIMEOUT_MS,
      maxBufferBytes: 1024 * 1024,
    });

    assert.strictEqual(outcome.kind, 'exit', `npm did not run: ${JSON.stringify(outcome)}`);
    assert.strictEqual(outcome.exitCode, 0);
    assert.match(outcome.stdout.trim(), /^\d+\.\d+\.\d+/);
  });

  test('npm audit of the fixture produces a report, not a spawn error', async () => {
    const outcome = await runAuditOutcome('npm', ['audit', '--json'], fixtureDir);

    assert.notStrictEqual(outcome.kind, 'error', `npm audit could not start: ${JSON.stringify(outcome)}`);
  });
});