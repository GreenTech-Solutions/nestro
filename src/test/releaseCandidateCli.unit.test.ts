import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mainReleaseCandidate, parseReleaseCandidateArgs } from '../tools';

const execFileAsync = promisify(execFile);
const SOURCE_SHA = 'a'.repeat(40);
const CI_RUN_ID = '42';
const VSIX_FILE = 'nestro-0.5.0.vsix';
const roots: string[] = [];

async function createCandidateFixture(): Promise<{ root: string; artifact: string; digest: string }> {
  const root = await mkdtemp(join(tmpdir(), 'nestro-release-candidate-'));
  roots.push(root);
  await execFileAsync('git', ['init', '--quiet'], { cwd: root });
  await mkdir(join(root, 'dist', 'ci'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{\n  "name": "nestro",\n  "version": "0.5.0"\n}\n', 'utf8');
  await writeFile(
    join(root, 'CHANGELOG.md'),
    '## [0.5.0](https://github.com/acme/nestro/compare/v0.4.2...v0.5.0) (2026-09-11)\n\n\n### Features\n\n* add preview\n\n',
    'utf8',
  );
  const artifact = join(root, 'dist', 'ci');
  const bytes = Buffer.from('verified-vsix-bytes');
  const digest = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(artifact, VSIX_FILE), bytes);
  await writeFile(join(artifact, `${VSIX_FILE}.manifest.txt`), `${digest}  extension/package.json\n`, 'utf8');
  await writeFile(join(artifact, `${VSIX_FILE}.sha256`), `${digest}  ${VSIX_FILE}\n`, 'utf8');
  await writeFile(join(artifact, 'evidence.json'), `${JSON.stringify({
    schemaVersion: 1,
    sourceSha: SOURCE_SHA,
    runId: CI_RUN_ID,
    runAttempt: '1',
    eventName: 'push',
    pullRequestHeadSha: null,
    vsixFile: VSIX_FILE,
    vsixSha256: digest,
    releaseEligible: false,
  })}\n`, 'utf8');
  return { root, artifact, digest };
}

function invokeCandidate(root: string, env: NodeJS.ProcessEnv = {}): Promise<number> {
  return mainReleaseCandidate(
    ['--artifact-dir', 'dist/ci', '--out-dir', 'dist/release-candidate'],
    root,
    env,
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })));
});

describe('release candidate CLI', () => {
  it('accepts only safe relative directories', () => {
    expect(parseReleaseCandidateArgs(['--artifact-dir', 'dist/ci', '--out-dir', 'dist/release'])).toEqual({
      artifactDir: 'dist/ci',
      outDir: 'dist/release',
    });
    expect(() => parseReleaseCandidateArgs([])).toThrow('usage');
    expect(() => parseReleaseCandidateArgs(['--artifact-dir', '../outside', '--out-dir', 'dist/release'])).toThrow('safe relative');
  });

  it('copies the exact verified bundle and writes an identity-bound candidate manifest', async () => {
    const { root, digest } = await createCandidateFixture();
    const output = join(root, 'github-output.txt');

    await expect(mainReleaseCandidate(
      ['--artifact-dir', 'dist/ci', '--out-dir', 'dist/release-candidate'],
      root,
      {
        GITHUB_OUTPUT: output,
        RELEASE_SOURCE_SHA: SOURCE_SHA,
        RELEASE_CI_RUN_ID: CI_RUN_ID,
        RELEASE_CANDIDATE_RUN_ID: '43',
      },
    )).resolves.toBe(0);

    const candidateDir = join(root, 'dist', 'release-candidate');
    expect((await readdir(candidateDir)).sort((left, right) => left.localeCompare(right))).toEqual([
      'candidate.json',
      `${VSIX_FILE}.manifest.txt`,
      `${VSIX_FILE}.sha256`,
      VSIX_FILE,
    ].sort((left, right) => left.localeCompare(right)));
    expect(JSON.parse(await readFile(join(candidateDir, 'candidate.json'), 'utf8'))).toMatchObject({
      schemaVersion: 1,
      version: '0.5.0',
      sourceSha: SOURCE_SHA,
      ciRunId: CI_RUN_ID,
      candidateRunId: '43',
      vsixFile: VSIX_FILE,
      digest,
    });
    expect(await readFile(output, 'utf8')).toContain('is-candidate=true');
    expect(await readFile(output, 'utf8')).toContain(`artifact-name=release-candidate-0.5.0-${SOURCE_SHA}`);
  });

  it.each([
    ['missing evidence', (artifact: string) => rm(join(artifact, 'evidence.json'))],
    ['wrong digest sidecar', (artifact: string) => writeFile(join(artifact, `${VSIX_FILE}.sha256`), `${'c'.repeat(64)}  ${VSIX_FILE}\n`, 'utf8')],
    ['extra artifact member', (artifact: string) => writeFile(join(artifact, 'forged.txt'), 'forged', 'utf8')],
    ['substituted VSIX bytes', (artifact: string) => writeFile(join(artifact, VSIX_FILE), 'forged', 'utf8')],
  ])('fails closed for %s', async (_label, mutate) => {
    const { root, artifact } = await createCandidateFixture();
    await mutate(artifact);
    const error = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(mainReleaseCandidate(
        ['--artifact-dir', 'dist/ci', '--out-dir', 'dist/release-candidate'],
        root,
        { RELEASE_SOURCE_SHA: SOURCE_SHA, RELEASE_CI_RUN_ID: CI_RUN_ID },
      )).resolves.toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Release candidate failed:'));
    }
    finally {
      error.mockRestore();
    }
  });

  it('rejects forged identity and missing release notes before copying artifacts', async () => {
    const { root, artifact } = await createCandidateFixture();
    const evidencePath = join(artifact, 'evidence.json');
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8')) as Record<string, unknown>;
    evidence.sourceSha = 'c'.repeat(40);
    await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, 'utf8');
    const error = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(mainReleaseCandidate(
        ['--artifact-dir', 'dist/ci', '--out-dir', 'dist/release-candidate'],
        root,
        { RELEASE_SOURCE_SHA: SOURCE_SHA, RELEASE_CI_RUN_ID: CI_RUN_ID },
      )).resolves.toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('source SHA'));
    }
    finally {
      error.mockRestore();
    }

    const second = await createCandidateFixture();
    await writeFile(join(second.root, 'CHANGELOG.md'), '## [0.5.0](link) (2026-09-11)\n\n', 'utf8');
    const secondError = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(mainReleaseCandidate(
        ['--artifact-dir', 'dist/ci', '--out-dir', 'dist/release-candidate'],
        second.root,
        { RELEASE_SOURCE_SHA: SOURCE_SHA, RELEASE_CI_RUN_ID: CI_RUN_ID },
      )).resolves.toBe(1);
      expect(secondError).toHaveBeenCalledWith(expect.stringContaining('no release notes'));
    }
    finally {
      secondError.mockRestore();
    }
  });

  it('reports argument and filesystem failures without throwing', async () => {
    const error = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(mainReleaseCandidate([], '/repo', {})).resolves.toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Release candidate failed:'));
    }
    finally {
      error.mockRestore();
    }
  });

  it.each([
    ['a non-object evidence document', (path: string) => writeFile(path, 'null\n', 'utf8'), 'must be an object'],
    ['an unexpected evidence field', async (path: string) => {
      const evidence = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      evidence.unexpected = true;
      await writeFile(path, `${JSON.stringify(evidence)}\n`, 'utf8');
    }, 'unexpected or missing fields'],
    ['a non-string run id', async (path: string) => {
      const evidence = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      evidence.runId = 42;
      await writeFile(path, `${JSON.stringify(evidence)}\n`, 'utf8');
    }, 'non-empty string'],
    ['a non-positive run id', async (path: string) => {
      const evidence = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      evidence.runId = '0';
      await writeFile(path, `${JSON.stringify(evidence)}\n`, 'utf8');
    }, 'positive integer'],
    ['a malformed schema version', async (path: string) => {
      const evidence = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      evidence.schemaVersion = 2;
      await writeFile(path, `${JSON.stringify(evidence)}\n`, 'utf8');
    }, 'schemaVersion 1'],
    ['a non-push event', async (path: string) => {
      const evidence = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      evidence.eventName = 'workflow_dispatch';
      await writeFile(path, `${JSON.stringify(evidence)}\n`, 'utf8');
    }, 'push run'],
    ['a pull request head', async (path: string) => {
      const evidence = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      evidence.pullRequestHeadSha = SOURCE_SHA;
      await writeFile(path, `${JSON.stringify(evidence)}\n`, 'utf8');
    }, 'null pull request head'],
    ['release eligibility', async (path: string) => {
      const evidence = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      evidence.releaseEligible = true;
      await writeFile(path, `${JSON.stringify(evidence)}\n`, 'utf8');
    }, 'releaseEligible=false'],
    ['a malformed source SHA', async (path: string) => {
      const evidence = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      evidence.sourceSha = 'short';
      await writeFile(path, `${JSON.stringify(evidence)}\n`, 'utf8');
    }, 'full lowercase 40-character commit SHA'],
    ['a malformed run attempt', async (path: string) => {
      const evidence = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      evidence.runAttempt = '0';
      await writeFile(path, `${JSON.stringify(evidence)}\n`, 'utf8');
    }, 'runAttempt must be a positive integer'],
    ['a malformed VSIX filename', async (path: string) => {
      const evidence = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      evidence.vsixFile = '../escape.vsix';
      await writeFile(path, `${JSON.stringify(evidence)}\n`, 'utf8');
    }, 'safe .vsix filename'],
    ['a malformed VSIX digest', async (path: string) => {
      const evidence = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      evidence.vsixSha256 = 'not-a-digest';
      await writeFile(path, `${JSON.stringify(evidence)}\n`, 'utf8');
    }, 'SHA-256 digest'],
  ] as const)('rejects %s before touching the candidate output', async (_label, mutate, message) => {
    const { root, artifact } = await createCandidateFixture();
    await mutate(join(artifact, 'evidence.json'));
    const error = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(invokeCandidate(root, { RELEASE_SOURCE_SHA: SOURCE_SHA, RELEASE_CI_RUN_ID: CI_RUN_ID })).resolves.toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining(message));
    }
    finally {
      error.mockRestore();
    }
    await expect(readdir(join(root, 'dist'))).resolves.not.toContain('release-candidate');
  });

  it.each([
    ['missing package.json', (root: string) => rm(join(root, 'package.json')), 'package.json could not be read'],
    ['invalid package.json', (root: string) => writeFile(join(root, 'package.json'), '{\n', 'utf8'), 'package.json is not valid JSON'],
    ['non-semver package version', (root: string) => writeFile(join(root, 'package.json'), '{"version":"v0.5.0"}\n', 'utf8'), 'plain major.minor.patch'],
    ['missing generated changelog entry', (root: string) => writeFile(join(root, 'CHANGELOG.md'), '# Changelog\n', 'utf8'), 'missing the generated'],
  ] as const)('reports %s from the checked-out source', async (_label, mutate, message) => {
    const { root } = await createCandidateFixture();
    await mutate(root);
    const error = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(invokeCandidate(root, { RELEASE_SOURCE_SHA: SOURCE_SHA, RELEASE_CI_RUN_ID: CI_RUN_ID })).resolves.toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining(message));
    }
    finally {
      error.mockRestore();
    }
  });

  it('returns a successful no-candidate result when the version is already tagged', async () => {
    const { root } = await createCandidateFixture();
    await execFileAsync('git', ['add', 'package.json', 'CHANGELOG.md'], { cwd: root });
    await execFileAsync('git', ['-c', 'user.email=tests@example.invalid', '-c', 'user.name=Candidate tests', 'commit', '--quiet', '-m', 'test'], { cwd: root });
    await execFileAsync('git', ['tag', 'v0.5.0'], { cwd: root });

    await expect(invokeCandidate(root, { RELEASE_SOURCE_SHA: SOURCE_SHA, RELEASE_CI_RUN_ID: CI_RUN_ID })).resolves.toBe(0);
    await expect(readdir(join(root, 'dist'))).resolves.not.toContain('release-candidate');
  });

  it.each([
    ['an invalid source SHA override', { RELEASE_SOURCE_SHA: 'short', RELEASE_CI_RUN_ID: CI_RUN_ID }, 'source SHA'],
    ['an invalid CI run override', { RELEASE_SOURCE_SHA: SOURCE_SHA, RELEASE_CI_RUN_ID: '0' }, 'run ID'],
  ])('rejects %s before preparing output', async (_label, env, message) => {
    const { root } = await createCandidateFixture();
    const error = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(invokeCandidate(root, env)).resolves.toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining(message));
    }
    finally {
      error.mockRestore();
    }
  });
});