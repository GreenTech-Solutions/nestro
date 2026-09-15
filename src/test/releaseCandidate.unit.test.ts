import { describe, expect, it } from 'vitest';
import {
  buildReleaseCandidate,
  findManifestViolation,
  isWellFormedManifest,
} from '../tools';
import type { ReleaseCandidateEvidence, ReleaseCandidateManifest } from '../tools';

const SOURCE_SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const RUN_ATTEMPT = '7';
const artifact = {
  vsixFile: 'nestro-0.5.0.vsix',
  digestFile: 'nestro-0.5.0.vsix.sha256',
  digest: DIGEST,
  manifestFile: 'nestro-0.5.0.vsix.manifest.txt',
  manifestSha256: 'c'.repeat(64),
  sbomFile: 'sbom.json',
  sbomSha256: 'd'.repeat(64),
  provenanceFile: 'provenance.json',
  provenanceSha256: 'e'.repeat(64),
} as const;

const evidence: ReleaseCandidateEvidence = {
  sourceSha: SOURCE_SHA,
  runId: '42',
  runAttempt: RUN_ATTEMPT,
  vsixFile: artifact.vsixFile,
  vsixSha256: DIGEST,
  eventName: 'push',
  pullRequestHeadSha: null,
  releaseEligible: false,
};

function validManifest(overrides: Partial<ReleaseCandidateManifest> = {}): ReleaseCandidateManifest {
  return {
    schemaVersion: 2,
    version: '0.5.0',
    sourceSha: SOURCE_SHA,
    ciRunId: '42',
    ciRunAttempt: RUN_ATTEMPT,
    candidateRunId: '43',
    ...artifact,
    notes: '### Features\n\n* add preview',
    ...overrides,
  };
}

describe('release candidate contract', () => {
  it('creates a manifest bound to source, CI and candidate run identities', () => {
    expect(buildReleaseCandidate(
      evidence,
      '0.5.0',
      ['v0.4.2'],
      '### Features\n\n* add preview',
      { expectedSourceSha: SOURCE_SHA, expectedCiRunId: '42', candidateRunId: '43', artifact },
    )).toEqual({
      isCandidate: true,
      manifest: validManifest(),
    });
  });

  it.each([
    ['an existing release tag', evidence, '0.5.0', ['v0.5.0'], { candidateRunId: '43', artifact }, 'already released'],
    ['a non-push event', { ...evidence, eventName: 'workflow_dispatch' }, '0.5.0', [], { candidateRunId: '43', artifact }, 'push run'],
    ['a PR head', { ...evidence, pullRequestHeadSha: 'c'.repeat(40) }, '0.5.0', [], { candidateRunId: '43', artifact }, 'pull request head'],
    ['release eligibility', { ...evidence, releaseEligible: true }, '0.5.0', [], { candidateRunId: '43', artifact }, 'releaseEligible=false'],
    ['a forged source SHA', evidence, '0.5.0', [], { expectedSourceSha: 'c'.repeat(40), candidateRunId: '43', artifact }, 'source SHA'],
    ['a forged CI run', evidence, '0.5.0', [], { expectedCiRunId: '99', candidateRunId: '43', artifact }, 'run ID'],
    ['an invalid package version', evidence, '0.5', [], { candidateRunId: '43', artifact }, 'plain major.minor.patch'],
    ['an invalid VSIX filename', { ...evidence, vsixFile: '../forged.vsix' }, '0.5.0', [], { candidateRunId: '43', artifact }, 'safe .vsix'],
    ['an invalid digest', { ...evidence, vsixSha256: 'not-a-digest' }, '0.5.0', [], { candidateRunId: '43', artifact }, 'SHA-256'],
    ['empty notes', evidence, '0.5.0', [], { candidateRunId: '43', artifact }, 'notes must be non-empty'],
    ['an invalid candidate run', evidence, '0.5.0', [], { candidateRunId: '0', artifact }, 'candidateRunId'],
  ] as const)('rejects %s', (_label, candidateEvidence, version, tags, context, reason) => {
    const outcome = buildReleaseCandidate(candidateEvidence, version, tags, '', context);
    expect(outcome).toMatchObject({ isCandidate: false });
    expect(outcome).toMatchObject({ reason: expect.stringContaining(reason) });
  });

  it('rejects malformed manifests and accepts the complete schema', () => {
    expect(findManifestViolation(validManifest())).toBeUndefined();
    expect(isWellFormedManifest(validManifest())).toBe(true);
    expect(isWellFormedManifest(null)).toBe(false);
    expect(isWellFormedManifest({})).toBe(false);
    expect(isWellFormedManifest({ ...validManifest(), unexpected: true })).toBe(false);
  });

  it.each([
    ['schema', { schemaVersion: 1 }, 'schemaVersion'],
    ['version', { version: 'v0.5.0' }, 'plain major.minor.patch'],
    ['source SHA', { sourceSha: 'short' }, 'full lowercase 40-character'],
    ['CI run', { ciRunId: '0' }, 'positive integer'],
    ['candidate run', { candidateRunId: '0' }, 'positive integer'],
    ['VSIX filename', { vsixFile: '../escape.vsix' }, 'safe .vsix filename'],
    ['digest', { digest: 'x' }, 'SHA-256'],
    ['notes', { notes: '  ' }, 'notes must be non-empty'],
    ['missing field', { ...validManifest(), digest: undefined }, 'member digests'],
  ] as const)('finds a malformed %s field', (_label, override, message) => {
    expect(findManifestViolation({ ...validManifest(), ...override } as ReleaseCandidateManifest)).toContain(message);
  });
});