import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildArtifactProvenance,
  buildArtifactSbom,
  buildNormalizedManifest,
  parsePackagedIdentity,
  readRuntimeDependencies,
  readVsixArchive,
  selectDeliveredRuntimeFiles,
} from '../tools';
import {
  buildZipFixture,
  CLEAN_EXTENSION_IDENTITY,
  CLEAN_VSIX_MANIFEST,
  cleanVsixFixtureEntries,
} from './fixtures/vsixFixtures';
import {
  assertSmokeSocketPathFits,
  buildVsixInstallArgs,
  installPackagedVsix,
  parsePackagedSmokeArgs,
  runPackagedSmokeWithDependencies,
  verifyDownloadedEvidence,
} from './packagedSmokeCli';
import type { PackagedSmokeDependencies } from './packagedSmokeCli';

const SOURCE_SHA = 'c'.repeat(40);
const CI_RUN_ID = '42';
const CI_RUN_ATTEMPT = '1';
const VSIX_FILE = 'nestro-0.4.2.vsix';
const roots: string[] = [];

interface EvidenceEventOverrides {
  readonly eventName?: 'push' | 'pull_request' | 'workflow_dispatch';
  readonly pullRequestHeadSha?: string | null;
}

async function createEvidenceDir(overrides: EvidenceEventOverrides = {}): Promise<{ dir: string; digest: string }> {
  const eventName = overrides.eventName ?? 'push';
  const pullRequestHeadSha = overrides.pullRequestHeadSha ?? null;
  const dir = await mkdtemp(join(tmpdir(), 'nestro-packaged-evidence-'));
  roots.push(dir);
  const bytes = buildZipFixture(cleanVsixFixtureEntries().map((entry) => {
    if (entry.path === 'extension/package.json') {
      return {
        ...entry,
        content: JSON.stringify({
          ...CLEAN_EXTENSION_IDENTITY,
          version: '0.4.2',
          main: './out/extension.cjs',
          icon: 'resources/icon.png',
        }),
      };
    }
    if (entry.path === 'extension.vsixmanifest') {
      return { ...entry, content: CLEAN_VSIX_MANIFEST.replaceAll('9.9.9', '0.4.2') };
    }
    return entry;
  }));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const archiveEntries = readVsixArchive(bytes);
  const packageEntry = archiveEntries.find(entry => entry.path === 'extension/package.json');
  if (packageEntry === undefined) {
    throw new Error('fixture package manifest missing');
  }
  const identity = parsePackagedIdentity(packageEntry.bytes);
  const packagedManifest = JSON.parse(new TextDecoder().decode(packageEntry.bytes)) as unknown;
  const runtimeDependencies = readRuntimeDependencies(packagedManifest);
  const runtimeFiles = selectDeliveredRuntimeFiles(archiveEntries);
  const normalizedManifest = buildNormalizedManifest(archiveEntries);
  const manifestSha256 = createHash('sha256').update(normalizedManifest).digest('hex');
  const sbomContents = `${JSON.stringify(buildArtifactSbom({
    identity,
    artifactFile: VSIX_FILE,
    artifactSha256: digest,
    runtimeFiles,
    dependencies: runtimeDependencies.dependencies,
    optionalDependencies: runtimeDependencies.optionalDependencies,
  }), undefined, 2)}\n`;
  const sbomSha256 = createHash('sha256').update(sbomContents).digest('hex');
  const provenanceContents = `${JSON.stringify(buildArtifactProvenance({
    sourceSha: SOURCE_SHA,
    ciRunId: CI_RUN_ID,
    ciRunAttempt: CI_RUN_ATTEMPT,
    eventName,
    repository: 'local/repository',
    signerWorkflow: 'local/repository/.github/workflows/ci.yml',
    artifactFile: VSIX_FILE,
    artifactSha256: digest,
    manifestFile: `${VSIX_FILE}.manifest.txt`,
    manifestSha256,
    sbomFile: 'sbom.json',
    sbomSha256,
  }), undefined, 2)}\n`;
  await writeFile(join(dir, VSIX_FILE), bytes);
  await writeFile(join(dir, `${VSIX_FILE}.sha256`), `${digest}  ${VSIX_FILE}\n`, 'utf8');
  await writeFile(join(dir, `${VSIX_FILE}.manifest.txt`), normalizedManifest, 'utf8');
  await writeFile(join(dir, 'evidence.json'), JSON.stringify({
    schemaVersion: 1,
    sourceSha: SOURCE_SHA,
    vsixFile: VSIX_FILE,
    vsixSha256: digest,
    runId: CI_RUN_ID,
    runAttempt: CI_RUN_ATTEMPT,
    eventName,
    pullRequestHeadSha,
    releaseEligible: false,
  }), 'utf8');
  await writeFile(join(dir, 'sbom.json'), sbomContents, 'utf8');
  await writeFile(join(dir, 'provenance.json'), provenanceContents, 'utf8');
  return { dir, digest };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('packaged smoke evidence verifier', () => {
  it('accepts exactly one evidence-only VSIX bound to the expected SHA and digest', async () => {
    const { dir } = await createEvidenceDir();

    await expect(verifyDownloadedEvidence(dir, SOURCE_SHA)).resolves.toBe(join(await realpath(dir), VSIX_FILE));
  });

  it('accepts a pull request identity with a full head SHA', async () => {
    const { dir } = await createEvidenceDir({ eventName: 'pull_request', pullRequestHeadSha: 'e'.repeat(40) });

    await expect(verifyDownloadedEvidence(dir, SOURCE_SHA)).resolves.toBe(join(await realpath(dir), VSIX_FILE));
  });

  it('accepts a workflow dispatch identity with a full head SHA', async () => {
    const { dir } = await createEvidenceDir({ eventName: 'workflow_dispatch', pullRequestHeadSha: 'f'.repeat(40) });

    await expect(verifyDownloadedEvidence(dir, SOURCE_SHA)).resolves.toBe(join(await realpath(dir), VSIX_FILE));
  });

  it.each([
    ['source substitution', async (dir: string) => {
      const evidence = JSON.parse(await readFile(join(dir, 'evidence.json'), 'utf8'));
      evidence.sourceSha = 'd'.repeat(40);
      await writeFile(join(dir, 'evidence.json'), JSON.stringify(evidence));
    }],
    ['release eligibility forgery', async (dir: string) => {
      const evidence = JSON.parse(await readFile(join(dir, 'evidence.json'), 'utf8'));
      evidence.releaseEligible = true;
      await writeFile(join(dir, 'evidence.json'), JSON.stringify(evidence));
    }],
    ['VSIX byte substitution', (dir: string) => writeFile(join(dir, VSIX_FILE), 'forged')],
    ['sidecar substitution', (dir: string) => writeFile(join(dir, `${VSIX_FILE}.sha256`), `${'0'.repeat(64)}  ${VSIX_FILE}\n`)],
    ['ambiguous VSIX', (dir: string) => writeFile(join(dir, 'other.vsix'), 'other')],
    ['missing normalized manifest', (dir: string) => rm(join(dir, `${VSIX_FILE}.manifest.txt`))],
    ['unknown event name', async (dir: string) => {
      const evidence = JSON.parse(await readFile(join(dir, 'evidence.json'), 'utf8'));
      evidence.eventName = 'schedule';
      await writeFile(join(dir, 'evidence.json'), JSON.stringify(evidence));
    }],
  ])('rejects %s', async (_label, inject) => {
    const { dir } = await createEvidenceDir();
    await inject(dir);

    await expect(verifyDownloadedEvidence(dir, SOURCE_SHA)).rejects.toThrow();
  });

  it('rejects a push identity that carries a head SHA', async () => {
    const { dir } = await createEvidenceDir({ eventName: 'push', pullRequestHeadSha: 'a'.repeat(40) });

    await expect(verifyDownloadedEvidence(dir, SOURCE_SHA)).rejects.toThrow('push identity without a head SHA');
  });

  it('rejects a pull request identity without a head SHA', async () => {
    const { dir } = await createEvidenceDir({ eventName: 'pull_request', pullRequestHeadSha: null });

    await expect(verifyDownloadedEvidence(dir, SOURCE_SHA)).rejects.toThrow('with a full head SHA');
  });

  it('rejects a workflow dispatch identity with a short head SHA', async () => {
    const { dir } = await createEvidenceDir({ eventName: 'workflow_dispatch', pullRequestHeadSha: 'abc123' });

    await expect(verifyDownloadedEvidence(dir, SOURCE_SHA)).rejects.toThrow('with a full head SHA');
  });

  it('requires explicit artifact directory and a full expected SHA', () => {
    expect(parsePackagedSmokeArgs([
      '--artifact-dir',
      'dist/ci',
      '--expected-sha',
      SOURCE_SHA,
      '--channel',
      'minimum',
    ])).toEqual({ artifactDir: 'dist/ci', expectedSha: SOURCE_SHA, channel: 'minimum' });
    expect(() => parsePackagedSmokeArgs([])).toThrow('usage');
    expect(() => parsePackagedSmokeArgs(['--artifact-dir', 'dist', '--expected-sha', 'short', '--channel', 'stable'])).toThrow('full lowercase');
    expect(() => parsePackagedSmokeArgs(['--artifact-dir', 'dist', '--expected-sha', SOURCE_SHA, '--channel', 'insiders'])).toThrow('minimum or stable');
  });

  it('quotes every Windows code.cmd argument so spaces and ampersands stay data', () => {
    expect(buildVsixInstallArgs(
      'C:\\safe dir\\nestro & evidence.vsix',
      'C:\\safe dir\\user data',
      'C:\\safe dir\\extensions',
      'win32',
    )).toEqual([
      '"--user-data-dir=C:\\safe dir\\user data"',
      '"--extensions-dir=C:\\safe dir\\extensions"',
      '"--install-extension"',
      '"C:\\safe dir\\nestro & evidence.vsix"',
      '"--force"',
    ]);
  });

  it.each(['%', '"', '\n', '\r'])('rejects unsafe Windows cmd data %j', (unsafe) => {
    expect(() => buildVsixInstallArgs(`C:\\artifact${unsafe}.vsix`, 'C:\\u', 'C:\\e', 'win32'))
      .toThrow('must not contain');
  });

  it('keeps explicit Windows profiles by disabling test-electron default profile injection', async () => {
    const runCommand = vi.fn().mockResolvedValue({ stderr: '', stdout: '' });

    await installPackagedVsix(
      'C:\\safe dir\\nestro & evidence.vsix',
      'stable',
      'C:\\safe dir\\cache',
      'C:\\safe dir\\user data',
      'C:\\safe dir\\extensions',
      'win32',
      runCommand,
    );

    expect(runCommand).toHaveBeenCalledExactlyOnceWith([
      '"--user-data-dir=C:\\safe dir\\user data"',
      '"--extensions-dir=C:\\safe dir\\extensions"',
      '"--install-extension"',
      '"C:\\safe dir\\nestro & evidence.vsix"',
      '"--force"',
    ], {
      cachePath: 'C:\\safe dir\\cache',
      reuseMachineInstall: true,
      version: 'stable',
    });
  });

  it('leaves Unix argv raw and fails early on an overlong Unix socket path', () => {
    expect(buildVsixInstallArgs('/safe dir/nestro & evidence.vsix', '/u', '/e', 'linux')[3])
      .toBe('/safe dir/nestro & evidence.vsix');
    expect(() => assertSmokeSocketPathFits(`/${'a'.repeat(100)}`, 'darwin')).toThrow('requires less than');
  });

  function createDependencies(overrides: Partial<PackagedSmokeDependencies> = {}): PackagedSmokeDependencies {
    const smokeRoot = '/isolated/smoke';
    return {
      verifyEvidence: vi.fn().mockResolvedValue('/evidence/nestro.vsix'),
      createTempRoot: vi.fn().mockResolvedValue(smokeRoot),
      createDriver: vi.fn().mockResolvedValue(`${smokeRoot}/driver`),
      prepareWorkspace: vi.fn().mockResolvedValue(undefined),
      download: vi.fn().mockResolvedValue(`${smokeRoot}/code`),
      install: vi.fn().mockResolvedValue(undefined),
      launch: vi.fn().mockResolvedValue(0),
      cleanup: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  const smokeOptions = { artifactDir: 'dist/ci', expectedSha: SOURCE_SHA, channel: 'stable' } as const;

  it('does not create state, install or launch when evidence verification fails', async () => {
    const dependencies = createDependencies({
      verifyEvidence: vi.fn().mockRejectedValue(new Error('digest mismatch')),
    });

    await expect(runPackagedSmokeWithDependencies(smokeOptions, '/repo', dependencies))
      .rejects.toThrow('digest mismatch');
    expect(dependencies.createTempRoot).not.toHaveBeenCalled();
    expect(dependencies.install).not.toHaveBeenCalled();
    expect(dependencies.launch).not.toHaveBeenCalled();
    expect(dependencies.cleanup).not.toHaveBeenCalled();
  });

  it('does not launch after install failure and still removes the isolated root', async () => {
    const dependencies = createDependencies({
      install: vi.fn().mockRejectedValue(new Error('install rejected')),
    });

    await expect(runPackagedSmokeWithDependencies(smokeOptions, '/repo', dependencies))
      .rejects.toThrow('install rejected');
    expect(dependencies.launch).not.toHaveBeenCalled();
    expect(dependencies.cleanup).toHaveBeenCalledExactlyOnceWith('/isolated/smoke');
  });

  it('propagates a non-zero Host result and still removes the isolated root', async () => {
    const dependencies = createDependencies({ launch: vi.fn().mockResolvedValue(7) });

    await expect(runPackagedSmokeWithDependencies(smokeOptions, '/repo', dependencies))
      .rejects.toThrow('exited with code 7');
    expect(dependencies.cleanup).toHaveBeenCalledExactlyOnceWith('/isolated/smoke');
  });

  it('runs verify, download, install and launch in order with isolated explicit paths', async () => {
    const calls: string[] = [];
    const dependencies = createDependencies({
      verifyEvidence: vi.fn(() => { calls.push('verify'); return Promise.resolve('/evidence/nestro.vsix'); }),
      download: vi.fn(() => { calls.push('download'); return Promise.resolve('/isolated/smoke/code'); }),
      install: vi.fn(() => { calls.push('install'); return Promise.resolve(); }),
      launch: vi.fn(() => { calls.push('launch'); return Promise.resolve(0); }),
      cleanup: vi.fn(() => { calls.push('cleanup'); return Promise.resolve(); }),
    });

    await runPackagedSmokeWithDependencies(smokeOptions, '/repo', dependencies);

    expect(calls).toEqual(['verify', 'download', 'install', 'launch', 'cleanup']);
    expect(dependencies.install).toHaveBeenCalledWith(
      '/evidence/nestro.vsix',
      'stable',
      '/isolated/smoke/cache',
      '/isolated/smoke/u',
      '/isolated/smoke/extensions',
    );
    expect(dependencies.launch).toHaveBeenCalledWith(
      '/isolated/smoke/code',
      '/isolated/smoke/driver',
      '/repo/out/test/packagedActivationRunner.js',
      '/isolated/smoke/u',
      '/isolated/smoke/extensions',
      '/isolated/smoke/workspace',
    );
  });
});