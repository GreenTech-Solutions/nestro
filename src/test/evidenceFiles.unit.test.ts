import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildNormalizedManifest,
  formatDigestSidecar,
  mainArtifactProvenance,
  mainReleaseCandidate,
  parseDigestSidecar,
  parseEvidence,
  parseEvidenceBytes,
  readDigestSidecar,
  readEvidenceFile,
  readVsixArchive,
  writeCiEvidence,
} from '../tools';
import { sha256Hex } from '../shared';
import { buildZipFixture, cleanVsixFixtureEntries } from './fixtures/vsixFixtures';

const execFileAsync = promisify(execFile);
const SOURCE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const DIGEST = 'c'.repeat(64);
const VSIX_FILE = 'nestro-9.9.9.vsix';
const roots: string[] = [];

function evidenceDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sourceSha: SOURCE_SHA,
    runId: '42',
    runAttempt: '1',
    eventName: 'push',
    pullRequestHeadSha: null,
    vsixFile: VSIX_FILE,
    vsixSha256: DIGEST,
    releaseEligible: false,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })));
});

describe('evidence.json parser', () => {
  it('accepts push evidence and pull request evidence with a full head SHA', () => {
    expect(parseEvidence(evidenceDocument())).toEqual(evidenceDocument());
    expect(parseEvidence(evidenceDocument({ eventName: 'pull_request', pullRequestHeadSha: HEAD_SHA })).pullRequestHeadSha).toBe(HEAD_SHA);
    expect(parseEvidence(evidenceDocument({ eventName: 'workflow_dispatch', pullRequestHeadSha: HEAD_SHA })).eventName).toBe('workflow_dispatch');
  });

  it.each([
    ['a non-object document', null, 'must be an object'],
    ['an unexpected field', evidenceDocument({ extra: true }), 'unexpected or missing fields'],
    ['another schema version', evidenceDocument({ schemaVersion: 2 }), 'schemaVersion 1'],
    ['release eligibility', evidenceDocument({ releaseEligible: true }), 'releaseEligible=false'],
    ['an unknown event', evidenceDocument({ eventName: 'schedule' }), 'unsupported eventName'],
    ['a non-string run id', evidenceDocument({ runId: 42 }), 'runId must be a non-empty string'],
    ['a short source SHA', evidenceDocument({ sourceSha: 'short' }), 'full lowercase 40-character commit SHA'],
    ['a zero run attempt', evidenceDocument({ runAttempt: '0' }), 'runAttempt must be a positive integer'],
    ['an unsafe VSIX file name', evidenceDocument({ vsixFile: '../escape.vsix' }), 'safe .vsix filename'],
    ['a malformed digest', evidenceDocument({ vsixSha256: 'not-a-digest' }), 'lowercase SHA-256 digest'],
    ['a push with a head SHA', evidenceDocument({ pullRequestHeadSha: HEAD_SHA }), 'does not match eventName'],
    ['a pull request without a head SHA', evidenceDocument({ eventName: 'pull_request' }), 'does not match eventName'],
    ['a dispatch with a short head SHA', evidenceDocument({ eventName: 'workflow_dispatch', pullRequestHeadSha: 'abc123' }), 'does not match eventName'],
  ])('rejects %s', (_label, document, message) => {
    expect(() => parseEvidence(document)).toThrow(message);
  });

  it('rejects bytes that are not UTF-8 JSON', () => {
    expect(() => parseEvidenceBytes(new TextEncoder().encode('{'))).toThrow('evidence.json is not valid JSON');
    expect(() => parseEvidenceBytes(new Uint8Array([0xff, 0xfe]))).toThrow('evidence.json is not valid JSON');
    expect(parseEvidenceBytes(new TextEncoder().encode(JSON.stringify(evidenceDocument())))).toEqual(evidenceDocument());
  });
});

describe('digest sidecar', () => {
  it('round-trips through the single formatter and parser', () => {
    expect(formatDigestSidecar(DIGEST, VSIX_FILE)).toBe(`${DIGEST}  ${VSIX_FILE}\n`);
    expect(parseDigestSidecar(formatDigestSidecar(DIGEST, VSIX_FILE), VSIX_FILE)).toBe(DIGEST);
  });

  it.each([
    ['a missing newline', `${DIGEST}  ${VSIX_FILE}`],
    ['CRLF line endings', `${DIGEST}  ${VSIX_FILE}\r\n`],
    ['a single separator space', `${DIGEST} ${VSIX_FILE}\n`],
    ['another file name', `${DIGEST}  other.vsix\n`],
    ['an uppercase digest', `${DIGEST.toUpperCase()}  ${VSIX_FILE}\n`],
    ['a second line', `${DIGEST}  ${VSIX_FILE}\n${DIGEST}  ${VSIX_FILE}\n`],
  ])('rejects %s', (_label, contents) => {
    expect(() => parseDigestSidecar(contents, VSIX_FILE)).toThrow('digest sidecar must contain exactly');
  });

  it('is read by the CI evidence writer, the provenance writer and the release candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestro-evidence-chain-'));
    roots.push(root);
    await execFileAsync('git', ['init', '--quiet'], { cwd: root });
    await writeFile(join(root, 'package.json'), '{\n  "name": "nestro",\n  "version": "9.9.9"\n}\n', 'utf8');
    await writeFile(join(root, 'CHANGELOG.md'), '## [9.9.9](https://github.com/acme/nestro/compare/v9.9.8...v9.9.9) (2026-09-11)\n\n\n### Features\n\n* add preview\n\n', 'utf8');
    const artifact = join(root, 'dist', 'ci');
    await mkdir(artifact, { recursive: true });
    const bytes = buildZipFixture(cleanVsixFixtureEntries());
    const digest = sha256Hex(bytes);
    await writeFile(join(artifact, VSIX_FILE), bytes);
    await writeFile(join(artifact, `${VSIX_FILE}.manifest.txt`), buildNormalizedManifest(readVsixArchive(bytes)), 'utf8');
    await writeFile(join(artifact, `${VSIX_FILE}.sha256`), formatDigestSidecar(digest, VSIX_FILE), 'utf8');
    await expect(readDigestSidecar(artifact, VSIX_FILE)).resolves.toBe(digest);

    const evidence = await writeCiEvidence(root, 'dist/ci', {
      sourceSha: SOURCE_SHA,
      runId: '42',
      runAttempt: '1',
      eventName: 'push',
      pullRequestHeadSha: undefined,
    });
    await expect(readEvidenceFile(artifact)).resolves.toEqual(evidence);
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await expect(mainArtifactProvenance(['--artifact-dir', 'dist/ci'], root, {})).resolves.toBe(0);
      await expect(mainReleaseCandidate(
        ['--artifact-dir', 'dist/ci', '--out-dir', 'dist/release-candidate'],
        root,
        { RELEASE_SOURCE_SHA: SOURCE_SHA, RELEASE_CI_RUN_ID: '42', RELEASE_CANDIDATE_RUN_ID: '43' },
      )).resolves.toBe(0);
    }
    finally {
      out.mockRestore();
    }
    await expect(readdir(join(root, 'dist', 'release-candidate'))).resolves.toContain(`${VSIX_FILE}.sha256`);
    await expect(readFile(join(root, 'dist', 'release-candidate', `${VSIX_FILE}.sha256`), 'utf8')).resolves.toBe(`${digest}  ${VSIX_FILE}\n`);
  });
});