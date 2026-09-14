const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const RUN_ID_PATTERN = /^[1-9]\d*$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const VSIX_FILE_PATTERN = /^[A-Za-z0-9._-]+\.vsix$/u;

export interface ReleaseCandidateEvidence {
  readonly sourceSha: string;
  readonly runId: string;
  readonly vsixFile: string;
  readonly vsixSha256: string;
  readonly eventName: string;
  readonly pullRequestHeadSha: string | null;
  readonly releaseEligible: boolean;
}

export interface ReleaseCandidateContext {
  readonly expectedSourceSha?: string;
  readonly expectedCiRunId?: string;
  readonly candidateRunId?: string;
}

export interface ReleaseCandidateManifest {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly sourceSha: string;
  readonly ciRunId: string;
  readonly candidateRunId?: string;
  readonly vsixFile: string;
  readonly digest: string;
  readonly notes: string;
}

export type ReleaseCandidateOutcome = { readonly isCandidate: true; readonly manifest: ReleaseCandidateManifest }
  | { readonly isCandidate: false; readonly reason: string };

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
  if (context.expectedSourceSha !== undefined && evidence.sourceSha !== context.expectedSourceSha) {
    return { isCandidate: false, reason: 'candidate source SHA does not match the verified workflow run' };
  }
  if (context.expectedCiRunId !== undefined && evidence.runId !== context.expectedCiRunId) {
    return { isCandidate: false, reason: 'candidate CI run ID does not match the verified workflow run' };
  }
  const manifest: ReleaseCandidateManifest = {
    schemaVersion: 1,
    version: packageVersion,
    sourceSha: evidence.sourceSha,
    ciRunId: evidence.runId,
    ...(context.candidateRunId === undefined ? {} : { candidateRunId: context.candidateRunId }),
    vsixFile: evidence.vsixFile,
    digest: evidence.vsixSha256,
    notes,
  };
  const violation = findManifestViolation(manifest);
  if (violation !== undefined) {
    return { isCandidate: false, reason: violation };
  }
  return { isCandidate: true, manifest };
}

export function findManifestViolation(manifest: ReleaseCandidateManifest): string | undefined {
  const expectedKeys = ['candidateRunId', 'ciRunId', 'digest', 'notes', 'schemaVersion', 'sourceSha', 'version', 'vsixFile'];
  const actualKeys = Object.keys(manifest).sort((left, right) => left.localeCompare(right));
  const requiredKeys = manifest.candidateRunId === undefined
    ? expectedKeys.filter(key => key !== 'candidateRunId')
    : expectedKeys;
  if (JSON.stringify(actualKeys) !== JSON.stringify(requiredKeys)) {
    return 'manifest contains unexpected or missing fields';
  }
  if (manifest.schemaVersion !== 1) {
    return 'schemaVersion must be exactly 1';
  }
  if (!VERSION_PATTERN.test(manifest.version)) {
    return 'version must be a plain major.minor.patch semver';
  }
  if (!COMMIT_SHA_PATTERN.test(manifest.sourceSha)) {
    return 'sourceSha must be a full lowercase 40-character commit SHA';
  }
  if (!RUN_ID_PATTERN.test(manifest.ciRunId)) {
    return 'ciRunId must be a positive integer';
  }
  if (manifest.candidateRunId !== undefined && !RUN_ID_PATTERN.test(manifest.candidateRunId)) {
    return 'candidateRunId must be a positive integer';
  }
  if (!VSIX_FILE_PATTERN.test(manifest.vsixFile)) {
    return 'vsixFile must be a safe .vsix filename';
  }
  if (!DIGEST_PATTERN.test(manifest.digest)) {
    return 'digest must be a lowercase 64-character SHA-256 hex digest';
  }
  if (manifest.notes.trim().length === 0) {
    return 'notes must be non-empty';
  }
  return undefined;
}

export function isWellFormedManifest(value: unknown): value is ReleaseCandidateManifest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const candidateRunIdIsValid = record.candidateRunId === undefined || typeof record.candidateRunId === 'string';
  return record.schemaVersion === 1
    && typeof record.version === 'string'
    && typeof record.sourceSha === 'string'
    && typeof record.ciRunId === 'string'
    && candidateRunIdIsValid
    && typeof record.vsixFile === 'string'
    && typeof record.digest === 'string'
    && typeof record.notes === 'string'
    && findManifestViolation(record as unknown as ReleaseCandidateManifest) === undefined;
}