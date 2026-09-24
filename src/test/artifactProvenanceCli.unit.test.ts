import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildNormalizedManifest,
  mainArtifactProvenance,
  parseArtifactProvenanceArgs,
  readVsixArchive,
} from '../tools';
import {
  buildZipFixture,
  cleanVsixFixtureEntries,
} from './fixtures/vsixFixtures';

const SOURCE_SHA = 'a'.repeat(40);
const VSIX_FILE = 'nestro-9.9.9.vsix';
const roots: string[] = [];

async function createProvenanceFixture(
  entries = cleanVsixFixtureEntries(),
): Promise<{ readonly root: string; readonly artifact: string; readonly digest: string }> {
  const root = await mkdtemp(join(tmpdir(), 'nestro-artifact-provenance-'));
  roots.push(root);
  const artifact = join(root, 'dist', 'ci');
  await mkdir(artifact, { recursive: true });
  const bytes = buildZipFixture(entries);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const archiveEntries = readVsixArchive(bytes);
  const manifest = buildNormalizedManifest(archiveEntries);
  await writeFile(join(artifact, VSIX_FILE), bytes);
  await writeFile(join(artifact, `${VSIX_FILE}.manifest.txt`), manifest, 'utf8');
  await writeFile(join(artifact, `${VSIX_FILE}.sha256`), `${digest}  ${VSIX_FILE}\n`, 'utf8');
  await writeFile(join(artifact, 'evidence.json'), `${JSON.stringify({
    schemaVersion: 1,
    sourceSha: SOURCE_SHA,
    runId: '42',
    runAttempt: '1',
    eventName: 'push',
    pullRequestHeadSha: null,
    vsixFile: VSIX_FILE,
    vsixSha256: digest,
    releaseEligible: false,
  })}\n`, 'utf8');
  return { root, artifact, digest };
}

async function mutateEvidence(
  evidencePath: string,
  mutate: (evidence: Record<string, unknown>) => void,
): Promise<void> {
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8')) as Record<string, unknown>;
  mutate(evidence);
  await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, 'utf8');
}

async function expectMainFailure(
  root: string,
  message: string,
  environment: NodeJS.ProcessEnv = {},
): Promise<void> {
  const error = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    await expect(mainArtifactProvenance(['--artifact-dir', 'dist/ci'], root, environment)).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(message));
  }
  finally {
    error.mockRestore();
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })));
});

describe('artifact provenance CLI', () => {
  it('accepts only the explicit safe artifact directory form', () => {
    expect(parseArtifactProvenanceArgs(['--artifact-dir', 'dist/ci'])).toEqual({ artifactDir: 'dist/ci' });
    expect(() => parseArtifactProvenanceArgs([])).toThrow('usage');
    expect(() => parseArtifactProvenanceArgs(['--artifact-dir', '../outside'])).toThrow('safe relative');
  });

  it('verifies the exact bundle and writes identity-bound SBOM and provenance', async () => {
    const { root, digest } = await createProvenanceFixture();
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await expect(mainArtifactProvenance(['--artifact-dir', 'dist/ci'], root, {})).resolves.toBe(0);
      expect(output).toHaveBeenCalledWith(`Provenance recorded for ${SOURCE_SHA}: ${VSIX_FILE}\n`);
    }
    finally {
      output.mockRestore();
    }
    const artifact = join(root, 'dist', 'ci');
    expect((await readdir(artifact)).sort((left, right) => left.localeCompare(right))).toEqual([
      'evidence.json',
      'provenance.json',
      'sbom.json',
      VSIX_FILE,
      `${VSIX_FILE}.manifest.txt`,
      `${VSIX_FILE}.sha256`,
    ].sort((left, right) => left.localeCompare(right)));
    expect(JSON.parse(await readFile(join(artifact, 'provenance.json'), 'utf8'))).toMatchObject({
      sourceSha: SOURCE_SHA,
      artifact: { file: VSIX_FILE, sha256: digest },
      attestation: { subjectName: VSIX_FILE, subjectDigest: `sha256:${digest}` },
    });
    expect(JSON.parse(await readFile(join(artifact, 'sbom.json'), 'utf8'))).toMatchObject({
      bomFormat: 'CycloneDX',
      metadata: { component: { name: 'nestro', version: '9.9.9' } },
    });
  });

  it('reports argument and artifact-directory failures without throwing', async () => {
    const error = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(mainArtifactProvenance([], '/repo', {})).resolves.toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('usage'));
    }
    finally {
      error.mockRestore();
    }

    const missing = await mkdtemp(join(tmpdir(), 'nestro-artifact-provenance-missing-'));
    roots.push(missing);
    await expectMainFailure(missing, 'ENOENT');

    const empty = await createProvenanceFixture();
    await rm(join(empty.artifact, VSIX_FILE));
    await expectMainFailure(empty.root, 'found 0');

    const duplicate = await createProvenanceFixture();
    await writeFile(join(duplicate.artifact, 'other.vsix'), 'not-a-vsix', 'utf8');
    await expectMainFailure(duplicate.root, 'found 2');

    const extra = await createProvenanceFixture();
    await writeFile(join(extra.artifact, 'extra.txt'), 'unexpected', 'utf8');
    await expectMainFailure(extra.root, 'exactly the verified VSIX');
  });

  it.each([
    ['non-object evidence', (path: string) => writeFile(path, 'null\n', 'utf8'), 'evidence.json must be an object'],
    ['unexpected evidence field', (path: string) => mutateEvidence(path, (evidence) => { evidence.extra = true; }), 'unexpected or missing fields'],
    ['invalid schema', (path: string) => mutateEvidence(path, (evidence) => { evidence.schemaVersion = 2; }), 'schemaVersion 1'],
    ['unsupported event', (path: string) => mutateEvidence(path, (evidence) => { evidence.eventName = 'release'; }), 'unsupported eventName'],
    ['non-string identity', (path: string) => mutateEvidence(path, (evidence) => { evidence.sourceSha = 42; }), 'non-empty string'],
    ['malformed source SHA', (path: string) => mutateEvidence(path, (evidence) => { evidence.sourceSha = 'short'; }), 'identity fields are malformed'],
    ['push pull-request head', (path: string) => mutateEvidence(path, (evidence) => { evidence.pullRequestHeadSha = SOURCE_SHA; }), 'does not match eventName'],
    ['workflow dispatch without head', (path: string) => mutateEvidence(path, (evidence) => {
      evidence.eventName = 'workflow_dispatch';
    }), 'does not match eventName'],
  ] as const)('rejects %s evidence', async (_label, mutate, message) => {
    const { root } = await createProvenanceFixture();
    await mutate(join(root, 'dist', 'ci', 'evidence.json'));
    await expectMainFailure(root, message);
  });

  it.each([
    ['evidence filename mismatch', (path: string) => mutateEvidence(path, (evidence) => { evidence.vsixFile = 'other.vsix'; }), 'filename does not match'],
    ['evidence digest mismatch', (path: string) => mutateEvidence(path, (evidence) => { evidence.vsixSha256 = 'b'.repeat(64); }), 'bytes do not match evidence'],
    ['malformed digest sidecar', (path: string) => writeFile(path, 'not a digest\n', 'utf8'), 'digest sidecar must contain exactly'],
    ['substituted digest sidecar', (path: string) => writeFile(path, `${'b'.repeat(64)}  ${VSIX_FILE}\n`, 'utf8'), 'sidecar does not match'],
    ['substituted normalized manifest', (path: string) => writeFile(path, 'not a manifest\n', 'utf8'), 'normalized manifest'],
  ] as const)('rejects %s', async (_label, mutate, message) => {
    const { root } = await createProvenanceFixture();
    const artifact = join(root, 'dist', 'ci');
    let target: string;
    if (_label.includes('sidecar')) {
      target = join(artifact, `${VSIX_FILE}.sha256`);
    }
    else if (_label.includes('manifest')) {
      target = join(artifact, `${VSIX_FILE}.manifest.txt`);
    }
    else {
      target = join(artifact, 'evidence.json');
    }
    await mutate(target);
    await expectMainFailure(root, message);
  });

  it('rejects malformed packaged identity, dependencies and missing package entry', async () => {
    const invalidJson = await createProvenanceFixture(cleanVsixFixtureEntries().map(entry => entry.path === 'extension/package.json'
      ? { ...entry, content: '{\n' }
      : entry));
    await expectMainFailure(invalidJson.root, 'extension/package.json is not valid JSON');

    const invalidIdentity = await createProvenanceFixture(cleanVsixFixtureEntries().map(entry => entry.path === 'extension/package.json'
      ? { ...entry, content: '{}' }
      : entry));
    await expectMainFailure(invalidIdentity.root, 'must contain non-empty name');

    const invalidDependencies = await createProvenanceFixture(cleanVsixFixtureEntries().map(entry => entry.path === 'extension/package.json'
      ? { ...entry, content: JSON.stringify({ name: 'nestro', version: '9.9.9', publisher: 'greentech-solutions', dependencies: [] }) }
      : entry));
    await expectMainFailure(invalidDependencies.root, 'dependencies must be an object');

    const missingPackage = await createProvenanceFixture(cleanVsixFixtureEntries().filter(entry => entry.path !== 'extension/package.json'));
    await expectMainFailure(missingPackage.root, 'must contain extension/package.json');
  });

  it('rejects metadata overrides that are empty, inconsistent or unsafe', async () => {
    const empty = await createProvenanceFixture();
    await expectMainFailure(empty.root, 'non-empty safe metadata value', { PROVENANCE_SOURCE_SHA: '' });

    const mismatch = await createProvenanceFixture();
    await expectMainFailure(mismatch.root, 'metadata does not match evidence', { PROVENANCE_SOURCE_SHA: 'b'.repeat(40) });

    const badRepository = await createProvenanceFixture();
    await expectMainFailure(badRepository.root, 'owner/name identifier', { PROVENANCE_REPOSITORY: 'not-a-repository' });

    const badWorkflow = await createProvenanceFixture();
    await expectMainFailure(badWorkflow.root, 'repository workflow', { PROVENANCE_SIGNER_WORKFLOW: 'acme/nestro/ci.yml' });
  });
});