import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createNodeReleasePrepareDependencies,
  mainReleasePrepare,
  parseCommitLog,
  parseReleasePrepareArgs,
} from '../tools';

const execFileAsync = promisify(execFile);

const repositoryRoot = resolve(import.meta.dirname, '../..');
const roots: string[] = [];

async function createReleaseRepository(commitSubject: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nestro-release-prepare-repo-'));
  roots.push(root);
  await execFileAsync('git', ['init', '--quiet', '-b', 'master'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'tests@example.invalid'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Release tests'], { cwd: root });
  await writeFile(join(root, 'package.json'), `${JSON.stringify({ name: 'nestro', version: '0.4.2' })}\n`, 'utf8');
  await writeFile(join(root, 'CHANGELOG.md'), '# Changelog\n', 'utf8');
  await writeFile(join(root, '.releaserc.json'), `${JSON.stringify({
    branches: ['master'],
    tagFormat: 'v${version}',
    plugins: [
      ['@semantic-release/commit-analyzer', {}],
      ['@semantic-release/release-notes-generator', {}],
    ],
  })}\n`, 'utf8');
  await execFileAsync('git', ['add', 'package.json', 'CHANGELOG.md', '.releaserc.json'], { cwd: root });
  await execFileAsync('git', ['commit', '--quiet', '-m', commitSubject], { cwd: root });
  await execFileAsync('git', ['tag', 'v0.4.2'], { cwd: root });
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })));
});

describe('release preparation CLI', () => {
  it('accepts only a safe output directory', () => {
    expect(parseReleasePrepareArgs(['--out-dir', 'dist/release'])).toBe('dist/release');
    expect(() => parseReleasePrepareArgs([])).toThrow('usage');
    expect(() => parseReleasePrepareArgs(['--out-dir', '../outside'])).toThrow('safe relative');
  });

  it('parses record and field separated git commit logs', () => {
    expect(parseCommitLog('a\u001fb\u001fc\u001ea2\u001fb2\u001fbody2\u001e')).toEqual([
      { hash: 'a', subject: 'b', body: 'c' },
      { hash: 'a2', subject: 'b2', body: 'body2' },
    ]);
    expect(parseCommitLog('  \u001e\n')).toEqual([]);
  });

  it('binds Node dependencies to git, package and changelog files', async () => {
    const dependencies = createNodeReleasePrepareDependencies(
      repositoryRoot,
      'dist/release',
      'https://github.com/acme/nestro',
      '2026-09-11',
      undefined,
    );
    await expect(dependencies.io.latestReleaseTag()).resolves.toBe('v0.4.2');
    const commits = await dependencies.io.listCommitsSince('v0.4.2');
    expect(commits.length).toBeGreaterThan(0);
    await expect(dependencies.io.readPackageVersion()).resolves.toBe('0.4.2');
  });

  it('exercises the Node-bound writers and successful release entrypoint', async () => {
    const root = await createReleaseRepository('fix: prepare a release');
    const output = join(root, 'github-output.txt');
    const dependencies = createNodeReleasePrepareDependencies(
      root,
      'dist/release',
      'https://github.com/acme/nestro',
      '2026-09-11',
      output,
    );
    await expect(dependencies.io.latestReleaseTag()).resolves.toBe('v0.4.2');
    await expect(dependencies.io.listCommitsSince('v0.4.2')).resolves.toHaveLength(0);
    await expect(dependencies.io.readPackageVersion()).resolves.toBe('0.4.2');
    await dependencies.io.writePackageVersion('0.4.3');
    await dependencies.io.prependChangelog('## [0.4.3](link) (2026-09-11)\n\n\n### Bug Fixes\n\n* prepared\n\n');
    await dependencies.io.writeNotes('### Bug Fixes\n\n* prepared');
    await dependencies.io.writeOutput('release-needed', 'true');
    await dependencies.io.writePackageVersion('0.4.2');
    const noOutput = createNodeReleasePrepareDependencies(
      root,
      'dist/release',
      'https://github.com/acme/nestro',
      '2026-09-11',
      undefined,
    );
    await noOutput.io.writeOutput('ignored', 'true');
    await execFileAsync('git', ['add', 'package.json', 'CHANGELOG.md'], { cwd: root });
    await execFileAsync('git', ['commit', '--quiet', '-m', 'fix: release metadata'], { cwd: root });

    await expect(mainReleasePrepare(
      ['--out-dir', 'dist/release'],
      root,
      { RELEASE_REPOSITORY_URL: 'https://github.com/acme/nestro', GITHUB_OUTPUT: output },
    )).resolves.toBe(0);
    expect(await readFile(join(output), 'utf8')).toContain('release-needed=true');
    expect(await readFile(join(root, 'dist', 'release', 'notes.md'), 'utf8')).toContain('Bug Fixes');
  });

  it('reports a no-release result from the real entrypoint', async () => {
    const root = await createReleaseRepository('docs: clarify release notes');
    await expect(mainReleasePrepare(
      ['--out-dir', 'dist/release'],
      root,
      { RELEASE_REPOSITORY_URL: 'https://github.com/acme/nestro' },
    )).resolves.toBe(0);
  });

  it('reports missing repository metadata before touching package files', async () => {
    const error = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(mainReleasePrepare(
        ['--out-dir', 'dist/release'],
        repositoryRoot,
        { RELEASE_CONFIG: '.releaserc.json' },
      )).resolves.toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('RELEASE_REPOSITORY_URL must be set'));
    }
    finally {
      error.mockRestore();
    }
  });

  it('rejects an invalid preparation config without running git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestro-release-prepare-'));
    roots.push(root);
    await writeFile(join(root, 'config.json'), '{"branches":["release"]}\n', 'utf8');
    const error = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(mainReleasePrepare(
        ['--out-dir', 'dist/release'],
        root,
        { RELEASE_CONFIG: 'config.json', RELEASE_REPOSITORY_URL: 'https://github.com/acme/nestro' },
      )).resolves.toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('release config must target only master'));
    }
    finally {
      error.mockRestore();
    }
  });

  it('reports malformed arguments without throwing', async () => {
    const error = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(mainReleasePrepare([], '/repo', {})).resolves.toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Release preparation failed:'));
    }
    finally {
      error.mockRestore();
    }
  });
});