import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildNormalizedManifest,
  mainArtifactProvenance,
  readEvidenceFile,
  readVsixArchive,
  verifyEvidenceBundle,
} from '../tools';
import { buildZipFixture, cleanVsixFixtureEntries } from './fixtures/vsixFixtures';

const SOURCE_SHA = 'a'.repeat(40);
const VSIX_FILE = 'nestro-9.9.9.vsix';
const ORIGIN = {
  repository: 'local/repository',
  signerWorkflow: 'local/repository/.github/workflows/ci.yml',
};
const roots: string[] = [];

async function createBundle(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nestro-evidence-bundle-'));
  roots.push(root);
  const artifact = join(root, 'dist', 'ci');
  await mkdir(artifact, { recursive: true });
  const bytes = buildZipFixture(cleanVsixFixtureEntries());
  const digest = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(artifact, VSIX_FILE), bytes);
  await writeFile(join(artifact, `${VSIX_FILE}.manifest.txt`), buildNormalizedManifest(readVsixArchive(bytes)), 'utf8');
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
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  try {
    await mainArtifactProvenance(['--artifact-dir', 'dist/ci'], root, { PROVENANCE_REPOSITORY: ORIGIN.repository, PROVENANCE_SIGNER_WORKFLOW: ORIGIN.signerWorkflow });
  }
  finally {
    output.mockRestore();
  }
  return artifact;
}

async function verify(artifact: string, origin?: typeof ORIGIN): ReturnType<typeof verifyEvidenceBundle> {
  return verifyEvidenceBundle(artifact, await readEvidenceFile(artifact), origin);
}

async function rewriteJson(file: string, mutate: (document: Record<string, unknown>) => void): Promise<void> {
  const document = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  mutate(document);
  await writeFile(file, `${JSON.stringify(document, undefined, 2)}\n`, 'utf8');
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })));
});

describe('verifyEvidenceBundle()', () => {
  it('accepts a generated bundle and reports the digest of every member', async () => {
    const artifact = await createBundle();
    const sha = async (file: string): Promise<string> => createHash('sha256').update(await readFile(join(artifact, file))).digest('hex');

    const verified = await verify(artifact, ORIGIN);

    expect(verified).toEqual({
      vsixFile: VSIX_FILE,
      digestFile: `${VSIX_FILE}.sha256`,
      digest: await sha(VSIX_FILE),
      manifestFile: `${VSIX_FILE}.manifest.txt`,
      manifestSha256: await sha(`${VSIX_FILE}.manifest.txt`),
      sbomFile: 'sbom.json',
      sbomSha256: await sha('sbom.json'),
      provenanceFile: 'provenance.json',
      provenanceSha256: await sha('provenance.json'),
    });
    await expect(verify(artifact)).resolves.toEqual(verified);
  });

  it('rejects a bundle with an unexpected member', async () => {
    const artifact = await createBundle();
    await writeFile(join(artifact, 'extra.txt'), 'extra', 'utf8');

    await expect(verify(artifact)).rejects.toThrow('six-member');
  });

  it('rejects an SBOM that is not JSON or does not describe the archive', async () => {
    const artifact = await createBundle();
    const sbomPath = join(artifact, 'sbom.json');
    await rewriteJson(sbomPath, (sbom) => { sbom.serialNumber = 'urn:uuid:00000000-0000-0000-0000-000000000000'; });
    await expect(verify(artifact)).rejects.toThrow('serialNumber');

    await writeFile(sbomPath, '{', 'utf8');
    await expect(verify(artifact)).rejects.toThrow('sbom.json is not valid JSON');
  });

  it('rejects provenance that is not JSON or is malformed, with or without an expected origin', async () => {
    const artifact = await createBundle();
    const provenancePath = join(artifact, 'provenance.json');
    await rewriteJson(provenancePath, (provenance) => { provenance.sourceSha = 'short'; });
    await expect(verify(artifact)).rejects.toThrow('identity fields are malformed');
    await expect(verify(artifact, ORIGIN)).rejects.toThrow('identity fields are malformed');

    await writeFile(provenancePath, '{', 'utf8');
    await expect(verify(artifact, ORIGIN)).rejects.toThrow('provenance.json is not valid JSON');
  });

  it('rejects provenance that does not match the evidence or the expected origin', async () => {
    const artifact = await createBundle();
    const provenancePath = join(artifact, 'provenance.json');

    await expect(verify(artifact, { ...ORIGIN, repository: 'other/repository' })).rejects.toThrow('exact candidate identity');

    await rewriteJson(provenancePath, (provenance) => { provenance.ciRunId = '43'; });
    await expect(verify(artifact)).rejects.toThrow('exact candidate identity');
  });
});