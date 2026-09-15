const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const RUN_ID_PATTERN = /^[1-9]\d*$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const SAFE_FILE_PATTERN = /^[A-Za-z0-9._-]+$/u;
const VSIX_FILE_PATTERN = /^[A-Za-z0-9._-]+\.vsix$/u;

export interface ReleaseCandidateEvidence {
  readonly sourceSha: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly vsixFile: string;
  readonly vsixSha256: string;
  readonly eventName: string;
  readonly pullRequestHeadSha: string | null;
  readonly releaseEligible: boolean;
}

/** Digests for every member copied into the immutable candidate artifact. */
export interface ReleaseCandidateArtifact {
  readonly vsixFile: string;
  readonly digestFile: string;
  readonly digest: string;
  readonly manifestFile: string;
  readonly manifestSha256: string;
  readonly sbomFile: string;
  readonly sbomSha256: string;
  readonly provenanceFile: string;
  readonly provenanceSha256: string;
}

export interface ReleaseCandidateContext {
  readonly expectedSourceSha?: string;
  readonly expectedCiRunId?: string;
  readonly candidateRunId?: string;
  readonly artifact?: ReleaseCandidateArtifact;
}

export interface ReleaseCandidateManifest extends ReleaseCandidateArtifact {
  readonly schemaVersion: 2;
  readonly version: string;
  readonly sourceSha: string;
  readonly ciRunId: string;
  readonly ciRunAttempt: string;
  readonly candidateRunId: string;
  readonly notes: string;
}

export type ReleaseCandidateOutcome = { readonly isCandidate: true; readonly manifest: ReleaseCandidateManifest }
  | { readonly isCandidate: false; readonly reason: string };

function defaultArtifact(evidence: ReleaseCandidateEvidence): ReleaseCandidateArtifact {
  return {
    vsixFile: evidence.vsixFile,
    digestFile: `${evidence.vsixFile}.sha256`,
    digest: evidence.vsixSha256,
    manifestFile: `${evidence.vsixFile}.manifest.txt`,
    manifestSha256: evidence.vsixSha256,
    sbomFile: 'sbom.json',
    sbomSha256: evidence.vsixSha256,
    provenanceFile: 'provenance.json',
    provenanceSha256: evidence.vsixSha256,
  };
}

function isSafeFile(file: string): boolean {
  return SAFE_FILE_PATTERN.test(file) && !file.endsWith('.');
}

function isValidArtifact(artifact: ReleaseCandidateArtifact, evidence: ReleaseCandidateEvidence): boolean {
  return artifact.vsixFile === evidence.vsixFile
    && artifact.digest === evidence.vsixSha256
    && artifact.digestFile === `${artifact.vsixFile}.sha256`
    && artifact.manifestFile === `${artifact.vsixFile}.manifest.txt`
    && artifact.sbomFile === 'sbom.json'
    && artifact.provenanceFile === 'provenance.json'
    && VSIX_FILE_PATTERN.test(artifact.vsixFile)
    && isSafeFile(artifact.digestFile)
    && isSafeFile(artifact.manifestFile)
    && isSafeFile(artifact.sbomFile)
    && isSafeFile(artifact.provenanceFile)
    && DIGEST_PATTERN.test(artifact.digest)
    && DIGEST_PATTERN.test(artifact.manifestSha256)
    && DIGEST_PATTERN.test(artifact.sbomSha256)
    && DIGEST_PATTERN.test(artifact.provenanceSha256);
}

export function buildReleaseCandidate(
  evidence: ReleaseCandidateEvidence,
  packageVersion: string,
  existingTags: readonly string[],
  notes: string,
  context: ReleaseCandidateContext = {},
): ReleaseCandidateOutcome {
  if (!VERSION_PATTERN.test(packageVersion)) {
    return { isCandidate: false, reason: `package version "${packageVersion}" is not a plain major.minor.patch semver` };
  }
  const tag = `v${packageVersion}`;
  if (existingTags.includes(tag)) {
    return { isCandidate: false, reason: `${tag} is already released` };
  }
  if (evidence.eventName !== 'push') {
    return { isCandidate: false, reason: 'candidate evidence must come from a push run' };
  }
  if (evidence.pullRequestHeadSha !== null) {
    return { isCandidate: false, reason: 'candidate evidence must not carry a pull request head' };
  }
  if (evidence.releaseEligible !== false) {
    return { isCandidate: false, reason: 'candidate evidence must be marked releaseEligible=false' };
  }
  if (!COMMIT_SHA_PATTERN.test(evidence.sourceSha)) {
    return { isCandidate: false, reason: 'candidate source SHA must be a full lowercase 40-character commit SHA' };
  }
  if (!RUN_ID_PATTERN.test(evidence.runId) || !RUN_ID_PATTERN.test(evidence.runAttempt)) {
    return { isCandidate: false, reason: 'candidate CI run ID and attempt must be positive integers' };
  }
  if (!VSIX_FILE_PATTERN.test(evidence.vsixFile)) {
    return { isCandidate: false, reason: 'candidate VSIX filename must be a safe .vsix filename' };
  }
  if (!DIGEST_PATTERN.test(evidence.vsixSha256)) {
    return { isCandidate: false, reason: 'candidate VSIX digest must be a lowercase SHA-256 digest' };
  }
  if (context.expectedSourceSha !== undefined && evidence.sourceSha !== context.expectedSourceSha) {
    return { isCandidate: false, reason: 'candidate source SHA does not match the verified workflow run' };
  }
  if (context.expectedCiRunId !== undefined && evidence.runId !== context.expectedCiRunId) {
    return { isCandidate: false, reason: 'candidate CI run ID does not match the verified workflow run' };
  }
  if (context.candidateRunId === undefined || !RUN_ID_PATTERN.test(context.candidateRunId)) {
    return { isCandidate: false, reason: 'candidateRunId must be a positive integer' };
  }
  const artifact = context.artifact ?? defaultArtifact(evidence);
  if (!isValidArtifact(artifact, evidence)) {
    return { isCandidate: false, reason: 'candidate artifact provenance members do not match the verified evidence' };
  }
  const manifest: ReleaseCandidateManifest = {
    schemaVersion: 2,
    version: packageVersion,
    sourceSha: evidence.sourceSha,
    ciRunId: evidence.runId,
    ciRunAttempt: evidence.runAttempt,
    candidateRunId: context.candidateRunId,
    ...artifact,
    notes,
  };
  const violation = findManifestViolation(manifest);
  if (violation !== undefined) {
    return { isCandidate: false, reason: violation };
  }
  return { isCandidate: true, manifest };
}

export function findManifestViolation(manifest: ReleaseCandidateManifest): string | undefined {
  const expectedKeys = [
    'candidateRunId',
    'ciRunAttempt',
    'ciRunId',
    'digest',
    'digestFile',
    'manifestFile',
    'manifestSha256',
    'notes',
    'provenanceFile',
    'provenanceSha256',
    'schemaVersion',
    'sbomFile',
    'sbomSha256',
    'sourceSha',
    'version',
    'vsixFile',
  ];
  const actualKeys = Object.keys(manifest).sort((left, right) => left.localeCompare(right));
  const requiredKeys = expectedKeys.slice().sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(actualKeys) !== JSON.stringify(requiredKeys)) {
    return 'manifest contains unexpected or missing fields';
  }
  if (manifest.schemaVersion !== 2) {
    return 'schemaVersion must be exactly 2';
  }
  if (typeof manifest.version !== 'string' || !VERSION_PATTERN.test(manifest.version)) {
    return 'version must be a plain major.minor.patch semver';
  }
  if (typeof manifest.sourceSha !== 'string' || !COMMIT_SHA_PATTERN.test(manifest.sourceSha)) {
    return 'sourceSha must be a full lowercase 40-character commit SHA';
  }
  if (typeof manifest.ciRunId !== 'string' || typeof manifest.ciRunAttempt !== 'string'
    || !RUN_ID_PATTERN.test(manifest.ciRunId) || !RUN_ID_PATTERN.test(manifest.ciRunAttempt)) {
    return 'ciRunId and ciRunAttempt must be positive integers';
  }
  if (typeof manifest.candidateRunId !== 'string' || !RUN_ID_PATTERN.test(manifest.candidateRunId)) {
    return 'candidateRunId must be a positive integer';
  }
  if (typeof manifest.vsixFile !== 'string' || !VSIX_FILE_PATTERN.test(manifest.vsixFile)) {
    return 'vsixFile must be a safe .vsix filename';
  }
  if (typeof manifest.digestFile !== 'string'
    || !isSafeFile(manifest.digestFile) || manifest.digestFile !== `${manifest.vsixFile}.sha256`) {
    return 'digestFile must be the VSIX SHA-256 sidecar';
  }
  if (typeof manifest.manifestFile !== 'string'
    || !isSafeFile(manifest.manifestFile) || manifest.manifestFile !== `${manifest.vsixFile}.manifest.txt`) {
    return 'manifestFile must be the VSIX normalized manifest sidecar';
  }
  if (typeof manifest.sbomFile !== 'string' || manifest.sbomFile !== 'sbom.json' || !isSafeFile(manifest.sbomFile)) {
    return 'sbomFile must be sbom.json';
  }
  if (typeof manifest.provenanceFile !== 'string' || manifest.provenanceFile !== 'provenance.json' || !isSafeFile(manifest.provenanceFile)) {
    return 'provenanceFile must be provenance.json';
  }
  if (typeof manifest.digest !== 'string' || typeof manifest.manifestSha256 !== 'string'
    || typeof manifest.sbomSha256 !== 'string' || typeof manifest.provenanceSha256 !== 'string'
    || !DIGEST_PATTERN.test(manifest.digest)
    || !DIGEST_PATTERN.test(manifest.manifestSha256)
    || !DIGEST_PATTERN.test(manifest.sbomSha256)
    || !DIGEST_PATTERN.test(manifest.provenanceSha256)) {
    return 'manifest member digests must be lowercase SHA-256 hex digests';
  }
  if (typeof manifest.notes !== 'string' || manifest.notes.trim().length === 0) {
    return 'notes must be non-empty';
  }
  return undefined;
}

export function isWellFormedManifest(value: unknown): value is ReleaseCandidateManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return findManifestViolation(value as ReleaseCandidateManifest) === undefined;
}