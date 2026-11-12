import { assertSafeFileName, assertSha256, SAFE_FILE_PATTERN, SHA256_PATTERN } from './artifactFields';
import { RELEASE_CONTRACT } from './releaseContract';
import { hasExactKeys, isRecord } from '../shared';

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const RUN_ID_PATTERN = /^[1-9]\d*$/u;
const SAFE_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SAFE_WORKFLOW_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/u;

export const ARTIFACT_SBOM_FILE = RELEASE_CONTRACT.bundle.sbom;
export const ARTIFACT_PROVENANCE_FILE = RELEASE_CONTRACT.bundle.provenance;
export const ARTIFACT_PROVENANCE_SCHEMA_VERSION = RELEASE_CONTRACT.schemaVersions.provenance;

export interface ArtifactProvenance {
  readonly schemaVersion: number;
  readonly sourceSha: string;
  readonly ciRunId: string;
  readonly ciRunAttempt: string;
  readonly eventName: 'push' | 'pull_request' | 'workflow_dispatch';
  readonly repository: string;
  readonly signerWorkflow: string;
  readonly artifact: {
    readonly file: string;
    readonly sha256: string;
    readonly manifestFile: string;
    readonly manifestSha256: string;
    readonly sbomFile: string;
    readonly sbomSha256: string;
  };
  readonly attestation: {
    readonly subjectName: string;
    readonly subjectDigest: string;
    readonly signerWorkflow: string;
  };
}

/** Everything a provenance document is derived from; building and verifying take the same input. */
export interface ArtifactProvenanceInput {
  readonly sourceSha: string;
  readonly ciRunId: string;
  readonly ciRunAttempt: string;
  readonly eventName: 'push' | 'pull_request' | 'workflow_dispatch';
  readonly repository: string;
  readonly signerWorkflow: string;
  readonly artifactFile: string;
  readonly artifactSha256: string;
  readonly manifestFile: string;
  readonly manifestSha256: string;
  readonly sbomFile: string;
  readonly sbomSha256: string;
}

function assembleProvenance(input: ArtifactProvenanceInput): ArtifactProvenance {
  return {
    schemaVersion: ARTIFACT_PROVENANCE_SCHEMA_VERSION,
    sourceSha: input.sourceSha,
    ciRunId: input.ciRunId,
    ciRunAttempt: input.ciRunAttempt,
    eventName: input.eventName,
    repository: input.repository,
    signerWorkflow: input.signerWorkflow,
    artifact: {
      file: input.artifactFile,
      sha256: input.artifactSha256,
      manifestFile: input.manifestFile,
      manifestSha256: input.manifestSha256,
      sbomFile: input.sbomFile,
      sbomSha256: input.sbomSha256,
    },
    attestation: {
      subjectName: input.artifactFile,
      subjectDigest: `sha256:${input.artifactSha256}`,
      signerWorkflow: input.signerWorkflow,
    },
  };
}

function assertProvenanceInput(input: ArtifactProvenanceInput): void {
  if (!COMMIT_SHA_PATTERN.test(input.sourceSha)) {
    throw new Error('provenance sourceSha must be a full lowercase 40-character commit SHA');
  }
  if (!RUN_ID_PATTERN.test(input.ciRunId) || !RUN_ID_PATTERN.test(input.ciRunAttempt)) {
    throw new Error('provenance CI run identity must use positive integer strings');
  }
  if (!SAFE_REPOSITORY_PATTERN.test(input.repository)) {
    throw new Error('provenance repository must be an owner/name identifier');
  }
  if (!SAFE_WORKFLOW_PATTERN.test(input.signerWorkflow)) {
    throw new Error('provenance signerWorkflow must identify a repository workflow');
  }
  assertSafeFileName(input.artifactFile, 'provenance artifact file');
  assertSafeFileName(input.manifestFile, 'provenance manifest file');
  assertSafeFileName(input.sbomFile, 'provenance SBOM file');
  assertSha256(input.artifactSha256, 'provenance artifact digest');
  assertSha256(input.manifestSha256, 'provenance manifest digest');
  assertSha256(input.sbomSha256, 'provenance SBOM digest');
}

export function buildArtifactProvenance(input: ArtifactProvenanceInput): ArtifactProvenance {
  assertProvenanceInput(input);
  const provenance = assembleProvenance(input);
  const violation = findArtifactProvenanceViolation(provenance, input);
  if (violation !== undefined) {
    throw new Error(violation);
  }
  return provenance;
}

function findShapeViolation(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return 'provenance must be an object';
  }
  if (!hasExactKeys(value, ['artifact', 'attestation', 'ciRunAttempt', 'ciRunId', 'eventName', 'repository', 'schemaVersion', 'signerWorkflow', 'sourceSha'])) {
    return 'provenance contains unexpected or missing fields';
  }
  if (value.schemaVersion !== ARTIFACT_PROVENANCE_SCHEMA_VERSION
    || (value.eventName !== 'push' && value.eventName !== 'pull_request' && value.eventName !== 'workflow_dispatch')
    || typeof value.sourceSha !== 'string' || !COMMIT_SHA_PATTERN.test(value.sourceSha)
    || typeof value.ciRunId !== 'string' || !RUN_ID_PATTERN.test(value.ciRunId)
    || typeof value.ciRunAttempt !== 'string' || !RUN_ID_PATTERN.test(value.ciRunAttempt)
    || typeof value.repository !== 'string' || !SAFE_REPOSITORY_PATTERN.test(value.repository)
    || typeof value.signerWorkflow !== 'string' || !SAFE_WORKFLOW_PATTERN.test(value.signerWorkflow)) {
    return 'provenance identity fields are malformed';
  }
  const artifact = value.artifact;
  if (!isRecord(artifact) || !hasExactKeys(artifact, ['file', 'manifestFile', 'manifestSha256', 'sbomFile', 'sbomSha256', 'sha256'])
    || typeof artifact.file !== 'string' || typeof artifact.manifestFile !== 'string' || typeof artifact.sbomFile !== 'string'
    || typeof artifact.sha256 !== 'string' || typeof artifact.manifestSha256 !== 'string' || typeof artifact.sbomSha256 !== 'string'
    || !SAFE_FILE_PATTERN.test(artifact.file) || !SAFE_FILE_PATTERN.test(artifact.manifestFile) || !SAFE_FILE_PATTERN.test(artifact.sbomFile)
    || !SHA256_PATTERN.test(artifact.sha256) || !SHA256_PATTERN.test(artifact.manifestSha256) || !SHA256_PATTERN.test(artifact.sbomSha256)) {
    return 'provenance artifact linkage is malformed';
  }
  const attestation = value.attestation;
  if (!isRecord(attestation) || !hasExactKeys(attestation, ['signerWorkflow', 'subjectDigest', 'subjectName'])
    || attestation.subjectName !== artifact.file
    || attestation.subjectDigest !== `sha256:${artifact.sha256}`
    || attestation.signerWorkflow !== value.signerWorkflow) {
    return 'provenance attestation subject or digest does not match the artifact';
  }
  return undefined;
}

/** Returns why `value` is not a provenance document, and, given an expectation, not exactly the one it builds. */
export function findArtifactProvenanceViolation(value: unknown, expectation?: ArtifactProvenanceInput): string | undefined {
  const shapeViolation = findShapeViolation(value);
  if (shapeViolation !== undefined) {
    return shapeViolation;
  }
  if (expectation !== undefined && JSON.stringify(value) !== JSON.stringify(assembleProvenance(expectation))) {
    return 'provenance does not match the exact candidate identity';
  }
  return undefined;
}