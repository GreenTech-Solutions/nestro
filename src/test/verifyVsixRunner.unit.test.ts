import { describe, expect, it } from 'vitest';
import { buildZipFixture, cleanVsixFixtureEntries } from './fixtures';
import { DEFAULT_OUT_DIR, parseVerifyVsixArgs, runVerifyVsixCli } from '../tools';
import type { VerifyVsixCliDependencies } from '../tools';
import { createFakeIo } from './fixtures/verifyVsixHarness';
import type { FakeIo } from './fixtures/verifyVsixHarness';

function createCliDependencies(fake: FakeIo): {
  deps: VerifyVsixCliDependencies;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    deps: { io: fake.io, writeOut: line => out.push(line), writeError: line => err.push(line) },
    out,
    err,
  };
}

describe('parseVerifyVsixArgs()', () => {
  it('defaults to the dist output directory and a permissive worktree', () => {
    expect(parseVerifyVsixArgs([])).toEqual({ outDir: DEFAULT_OUT_DIR, requireCleanWorktree: false });
  });

  it('accepts an explicit output directory', () => {
    expect(parseVerifyVsixArgs(['--out-dir', 'build/artifacts']))
      .toEqual({ outDir: 'build/artifacts', requireCleanWorktree: false });
  });

  it('canonicalizes a valid nested output directory', () => {
    expect(parseVerifyVsixArgs(['--out-dir', 'build//nested/./verified/']))
      .toEqual({ outDir: 'build/nested/verified', requireCleanWorktree: false });
  });

  it.each([
    ['the repository root', '.'],
    ['an empty path', ''],
    ['a POSIX absolute path', '/outside/vsix'],
    ['a Windows drive path', 'Z:\\outside\\vsix'],
    ['a Windows UNC path', '\\\\server\\share\\vsix'],
    ['a parent escape', '../outside'],
    ['a nested parent escape', 'build/../../outside'],
    ['a control character', 'dist\nother'],
  ])('rejects %s as an artifact output directory', (_label, outDir) => {
    expect(() => parseVerifyVsixArgs(['--out-dir', outDir]))
      .toThrow('safe relative subdirectory');
  });

  it('accepts the clean-worktree switch the release pipeline needs', () => {
    expect(parseVerifyVsixArgs(['--require-clean-worktree']))
      .toEqual({ outDir: DEFAULT_OUT_DIR, requireCleanWorktree: true });
  });

  it.each([
    ['a missing --out-dir value', ['--out-dir'], '--out-dir requires a directory argument'],
    ['an --out-dir value that is another flag', ['--out-dir', '--verbose'], '--out-dir requires a directory argument'],
    ['an unknown flag', ['--strict'], 'Unknown argument: --strict'],
  ])('rejects %s', (_label, argv, message) => {
    expect(() => parseVerifyVsixArgs(argv)).toThrow(message);
  });
});

describe('runVerifyVsixCli()', () => {
  it('rejects an unsafe output directory before preparing, locking, removing, or packaging', async () => {
    const fake = createFakeIo();
    const { deps, out, err } = createCliDependencies(fake);

    await expect(runVerifyVsixCli(['--out-dir', '../outside'], deps)).resolves.toBe(1);

    expect(err.join('\n')).toContain('safe relative subdirectory');
    expect(out).toEqual([]);
    expect(fake.ensured).toEqual([]);
    expect(fake.locksAcquired).toEqual([]);
    expect(fake.removed).toEqual([]);
    expect(fake.packaged).toEqual([]);
  });

  it('prints the normalized source manifest to stdout and the summary to stderr', async () => {
    const fake = createFakeIo();
    const { deps, out, err } = createCliDependencies(fake);

    await expect(runVerifyVsixCli([], deps)).resolves.toBe(0);
    expect(out).toContain('out/extension.cjs');
    expect(out).toContain('README.md');
    expect(err.join('\n')).toContain('VSIX verified: 10/26 files');
    expect(err.some(line => line.includes('sha256:'))).toBe(true);
  });

  it('reports every violation on stderr and fails', async () => {
    const archive = buildZipFixture([
      ...cleanVsixFixtureEntries(),
      { path: 'extension/out/extension.cjs.map', content: '{}' },
    ]);
    const { deps, out, err } = createCliDependencies(createFakeIo({ archive }));

    await expect(runVerifyVsixCli([], deps)).resolves.toBe(1);
    expect(err[0]).toContain('VSIX policy rejected');
    expect(err.join('\n')).toContain('[forbidden-file] out/extension.cjs.map');
    expect(err.join('\n')).toContain('Rejected VSIX artifacts removed');
    expect(out).toEqual([]);
  });

  it('keeps stdout empty on rejection so a downstream grep on the manifest cannot report success', async () => {
    const archive = buildZipFixture([
      ...cleanVsixFixtureEntries(),
      { path: 'extension/CODESTYLE.md', content: '# Codestyle\n' },
    ]);
    const { deps, out, err } = createCliDependencies(createFakeIo({ archive }));

    await expect(runVerifyVsixCli([], deps)).resolves.toBe(1);
    // The exact shape of release.yml step 6: `pnpm check:vsce | grep -Fxq 'out/extension.cjs'`
    // under `bash -e` without pipefail takes its status from grep, so the entrypoint line
    // must not reach stdout unless the package was accepted.
    expect(out).not.toContain('out/extension.cjs');
    expect(out).toEqual([]);
    expect(err.some(line => line.includes('[forbidden-file] CODESTYLE.md'))).toBe(true);
  });

  it('emits the manifest on stdout only after the package is accepted', async () => {
    const { deps, out } = createCliDependencies(createFakeIo());

    await expect(runVerifyVsixCli([], deps)).resolves.toBe(0);
    expect(out).toContain('out/extension.cjs');
    expect(out).toHaveLength(10);
  });

  it('warns on stderr about a locally modified packaged file but still accepts the package', async () => {
    const { deps, out, err } = createCliDependencies(createFakeIo({ modified: ['README.md'] }));

    await expect(runVerifyVsixCli([], deps)).resolves.toBe(0);
    expect(err.join('\n')).toContain('VSIX warning: README.md is tracked but modified');
    expect(out).toContain('out/extension.cjs');
  });

  it('fails on a locally modified packaged file when the clean-worktree switch is set', async () => {
    const { deps, out, err } = createCliDependencies(createFakeIo({ modified: ['README.md'] }));

    await expect(runVerifyVsixCli(['--require-clean-worktree'], deps)).resolves.toBe(1);
    expect(err.join('\n')).toContain('[modified-tracked-file] README.md');
    expect(out).toEqual([]);
  });

  it.each([
    'src/extension.ts',
    'tsdown.config.mts',
  ])('fails strict verification when build input %s is modified', async (sourcePath) => {
    const { deps, out, err } = createCliDependencies(createFakeIo({ modified: [sourcePath] }));

    await expect(runVerifyVsixCli(['--require-clean-worktree'], deps)).resolves.toBe(1);
    expect(err.join('\n')).toContain(`[modified-tracked-file] ${sourcePath}`);
    expect(out).toEqual([]);
  });

  it('fails strict verification when an untracked build input is present', async () => {
    const sourcePath = 'src/generatedBuildInput.ts';
    const { deps, out, err } = createCliDependencies(createFakeIo({ untracked: [sourcePath] }));

    await expect(runVerifyVsixCli(['--require-clean-worktree'], deps)).resolves.toBe(1);
    expect(err.join('\n')).toContain(`[untracked-worktree-file] ${sourcePath}`);
    expect(out).toEqual([]);
  });

  it('excludes only its own active lock from a strict custom-output worktree scan', async () => {
    const ownLock = 'build/verified/nestro-9.9.9.vsix.lock';
    const fake = createFakeIo({ untracked: [ownLock] });
    const { deps, out, err } = createCliDependencies(fake);

    await expect(runVerifyVsixCli(['--require-clean-worktree', '--out-dir', 'build/verified'], deps))
      .resolves.toBe(0);
    expect(err.join('\n')).not.toContain('[untracked-worktree-file]');
    expect(out).toContain('out/extension.cjs');
  });

  it('still rejects every other untracked lock beside its exact active lock', async () => {
    const ownLock = 'build/verified/nestro-9.9.9.vsix.lock';
    const otherLock = 'build/verified/other.vsix.lock';
    const fake = createFakeIo({ untracked: [ownLock, otherLock] });
    const { deps, out, err } = createCliDependencies(fake);

    await expect(runVerifyVsixCli(['--require-clean-worktree', '--out-dir', 'build/verified'], deps))
      .resolves.toBe(1);
    expect(err.join('\n')).not.toContain(`[untracked-worktree-file] ${ownLock}`);
    expect(err.join('\n')).toContain(`[untracked-worktree-file] ${otherLock}`);
    expect(out).toEqual([]);
  });

  it('still reports warnings on stderr when the package is rejected', async () => {
    const archive = buildZipFixture([
      ...cleanVsixFixtureEntries(),
      { path: 'extension/CODESTYLE.md', content: '# Codestyle\n' },
    ]);
    const { deps, out, err } = createCliDependencies(createFakeIo({ archive, modified: ['README.md'] }));

    await expect(runVerifyVsixCli([], deps)).resolves.toBe(1);
    expect(err.join('\n')).toContain('VSIX warning: README.md is tracked but modified');
    expect(err.join('\n')).toContain('[forbidden-file] CODESTYLE.md');
    expect(out).toEqual([]);
  });

  it('fails when packaging itself fails', async () => {
    const fake = createFakeIo({ packageError: new Error('vsce package failed: exit 1') });
    const { deps, err } = createCliDependencies(fake);

    await expect(runVerifyVsixCli([], deps)).resolves.toBe(1);
    expect(err.join('\n')).toContain('VSIX verification failed: vsce package failed: exit 1');
  });

  it('describes a non-Error lock acquisition failure', async () => {
    const { deps, err } = createCliDependencies(createFakeIo({ lockAcquireError: 'lock device failed' }));

    await expect(runVerifyVsixCli([], deps)).resolves.toBe(1);
    expect(err.join('\n')).toContain('VSIX verification failed: lock device failed');
  });

  it('fails on an unusable archive without throwing', async () => {
    const fake = createFakeIo({ archive: new Uint8Array(4) });
    const { deps, err } = createCliDependencies(fake);

    await expect(runVerifyVsixCli([], deps)).resolves.toBe(1);
    expect(err.join('\n')).toContain('too small');
  });

  it('fails on bad arguments before packaging anything', async () => {
    const fake = createFakeIo();
    const { deps, err } = createCliDependencies(fake);

    await expect(runVerifyVsixCli(['--nope'], deps)).resolves.toBe(1);
    expect(err.join('\n')).toContain('Unknown argument: --nope');
    expect(fake.packaged).toEqual([]);
  });

  it('honours a custom output directory', async () => {
    const fake = createFakeIo();
    const { deps } = createCliDependencies(fake);

    await expect(runVerifyVsixCli(['--out-dir', 'build/verified'], deps)).resolves.toBe(0);
    expect(fake.packaged).toEqual(['build/verified/nestro-9.9.9.vsix']);
    expect([...fake.written.keys()]).toEqual([
      'build/verified/nestro-9.9.9.vsix.manifest.txt',
      'build/verified/nestro-9.9.9.vsix.sha256',
    ]);
  });
});