import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bundleFileName, EVIDENCE_FILE, RELEASE_CONTRACT, VSIX_FILE_PATTERN } from './releaseContract';
import { describeError, hasExactKeys, isRecord } from '../shared';

export const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
export const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const DIGEST_LINE_PATTERN = /^([0-9a-f]{64}) {2}([^\r\n]+)\n$/u;
const EVIDENCE_KEYS = [
  'eventName',
  'pullRequestHeadSha',
  'releaseEligible',
  'runAttempt',
  'runId',
  'schemaVersion',
  'sourceSha',
  'vsixFile',
  'vsixSha256',
];

export type EvidenceEventName = 'push' | 'pull_request' | 'workflow_dispatch';

export interface CiEvidence {
  readonly schemaVersion: number;
  readonly sourceSha: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly eventName: EvidenceEventName;
  readonly pullRequestHeadSha: string | null;
  readonly vsixFile: string;
  readonly vsixSha256: string;
  readonly releaseEligible: false;
}

function isEventName(value: unknown): value is EvidenceEventName {
  return value === 'push' || value === 'pull_request' || value === 'workflow_dispatch';
}

function evidenceString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${EVIDENCE_FILE} ${field} must be a non-empty string`);
  }
  return value;
}

function requireEvidenceFormat(evidence: CiEvidence): void {
  if (!COMMIT_SHA_PATTERN.test(evidence.sourceSha)) {
    throw new Error(`${EVIDENCE_FILE} sourceSha must be a full lowercase 40-character commit SHA`);
  }
  if (!POSITIVE_INTEGER_PATTERN.test(evidence.runId)) {
    throw new Error(`${EVIDENCE_FILE} runId must be a positive integer`);
  }
  if (!POSITIVE_INTEGER_PATTERN.test(evidence.runAttempt)) {
    throw new Error(`${EVIDENCE_FILE} runAttempt must be a positive integer`);
  }
  if (!VSIX_FILE_PATTERN.test(evidence.vsixFile)) {
    throw new Error(`${EVIDENCE_FILE} vsixFile must be a safe ${RELEASE_CONTRACT.bundle.vsixExtension} filename`);
  }
  if (!SHA256_PATTERN.test(evidence.vsixSha256)) {
    throw new Error(`${EVIDENCE_FILE} vsixSha256 must be a lowercase SHA-256 digest`);
  }
  const hasHeadSha = COMMIT_SHA_PATTERN.test(evidence.pullRequestHeadSha ?? '');
  if (evidence.eventName === 'push' ? evidence.pullRequestHeadSha !== null : !hasHeadSha) {
    throw new Error(`${EVIDENCE_FILE} pull request identity does not match eventName`);
  }
}

/** Validates a parsed `evidence.json` document; the only reader of the evidence schema. */
export function parseEvidence(value: unknown): CiEvidence {
  if (!isRecord(value)) {
    throw new Error(`${EVIDENCE_FILE} must be an object`);
  }
  if (!hasExactKeys(value, EVIDENCE_KEYS)) {
    throw new Error(`${EVIDENCE_FILE} contains unexpected or missing fields`);
  }
  if (value.schemaVersion !== RELEASE_CONTRACT.schemaVersions.evidence || value.releaseEligible !== false) {
    throw new Error(`${EVIDENCE_FILE} must use schemaVersion ${RELEASE_CONTRACT.schemaVersions.evidence} and releaseEligible=false`);
  }
  if (!isEventName(value.eventName)) {
    throw new Error(`${EVIDENCE_FILE} has an unsupported eventName`);
  }
  const evidence: CiEvidence = {
    schemaVersion: value.schemaVersion,
    sourceSha: evidenceString(value.sourceSha, 'sourceSha'),
    runId: evidenceString(value.runId, 'runId'),
    runAttempt: evidenceString(value.runAttempt, 'runAttempt'),
    eventName: value.eventName,
    pullRequestHeadSha: value.pullRequestHeadSha === null ? null : evidenceString(value.pullRequestHeadSha, 'pullRequestHeadSha'),
    vsixFile: evidenceString(value.vsixFile, 'vsixFile'),
    vsixSha256: evidenceString(value.vsixSha256, 'vsixSha256'),
    releaseEligible: false,
  };
  requireEvidenceFormat(evidence);
  return evidence;
}

export function parseEvidenceBytes(bytes: Uint8Array): CiEvidence {
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  }
  catch (error) {
    throw new Error(`${EVIDENCE_FILE} is not valid JSON: ${describeError(error)}`, { cause: error });
  }
  return parseEvidence(document);
}

export async function readEvidenceFile(artifactDir: string): Promise<CiEvidence> {
  return parseEvidenceBytes(await readFile(join(artifactDir, EVIDENCE_FILE)));
}

/** The digest sidecar contents: `<sha256>  <file>` and one newline. */
export function formatDigestSidecar(digest: string, file: string): string {
  return `${digest}  ${file}\n`;
}

export function parseDigestSidecar(contents: string, expectedFile: string): string {
  const match = DIGEST_LINE_PATTERN.exec(contents);
  if (match === null || match[2] !== expectedFile) {
    throw new Error(`digest sidecar must contain exactly "<sha256>  ${expectedFile}"`);
  }
  return match[1];
}

export async function readDigestSidecar(artifactDir: string, vsixFile: string): Promise<string> {
  return parseDigestSidecar(await readFile(join(artifactDir, bundleFileName('digest', vsixFile)), 'utf8'), vsixFile);
}