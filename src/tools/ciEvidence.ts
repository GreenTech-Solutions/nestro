import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { bundleFileName, RELEASE_CONTRACT } from './releaseContract';
import { compareCodeUnits, sha256Hex } from '../shared';

const SHA256_LINE_PATTERN = /^([0-9a-f]{64}) {2}([^\r\n]+)\r?\n?$/u;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/u;

export interface CiEvidenceEnvironment {
  readonly sourceSha: string | undefined;
  readonly runId: string | undefined;
  readonly runAttempt: string | undefined;
  readonly eventName: string | undefined;
  readonly pullRequestHeadSha: string | undefined;
}

export interface CiEvidence {
  readonly schemaVersion: number;
  readonly sourceSha: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly eventName: string;
  readonly pullRequestHeadSha: string | null;
  readonly vsixFile: string;
  readonly vsixSha256: string;
  readonly releaseEligible: false;
}

function requireCommitSha(value: string | undefined, label: string): string {
  if (value === undefined || !COMMIT_SHA_PATTERN.test(value)) {
    throw new Error(`${label} must be a full lowercase 40-character commit SHA`);
  }
  return value;
}

function requirePositiveInteger(value: string | undefined, label: string): string {
  if (value === undefined || !POSITIVE_INTEGER_PATTERN.test(value)) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function requireEventName(value: string | undefined): 'pull_request' | 'push' | 'workflow_dispatch' {
  if (value !== 'pull_request' && value !== 'push' && value !== 'workflow_dispatch') {
    throw new Error('CI_EVENT_NAME must be pull_request, push or workflow_dispatch');
  }
  return value;
}

function parseDigestFile(contents: string, expectedFile: string): string {
  const match = SHA256_LINE_PATTERN.exec(contents);
  if (match === null || match[2] !== expectedFile) {
    throw new Error(`digest sidecar must contain exactly "<sha256>  ${expectedFile}"`);
  }
  return match[1];
}

export async function createCiEvidence(
  artifactDir: string,
  environment: CiEvidenceEnvironment,
): Promise<CiEvidence> {
  const entries = await readdir(artifactDir);
  const vsixFiles = entries.filter(entry => entry.endsWith(RELEASE_CONTRACT.bundle.vsixExtension));
  if (vsixFiles.length !== 1) {
    throw new Error(`artifact directory must contain exactly one VSIX, found ${vsixFiles.length}`);
  }
  const vsixFile = basename(vsixFiles[0]);
  const expectedEntries = [vsixFile, bundleFileName('manifest', vsixFile), bundleFileName('digest', vsixFile)].sort(compareCodeUnits);
  if (entries.slice().sort(compareCodeUnits).join('\n') !== expectedEntries.join('\n')) {
    throw new Error('artifact directory must contain exactly the VSIX, normalized manifest and SHA-256 sidecar');
  }
  const vsixBytes = await readFile(join(artifactDir, vsixFile));
  const sidecarDigest = parseDigestFile(await readFile(join(artifactDir, bundleFileName('digest', vsixFile)), 'utf8'), vsixFile);
  const actualDigest = sha256Hex(vsixBytes);
  if (sidecarDigest !== actualDigest) {
    throw new Error(`VSIX digest mismatch: sidecar ${sidecarDigest}, actual ${actualDigest}`);
  }
  const sourceSha = requireCommitSha(environment.sourceSha, 'CI_SOURCE_SHA');
  const eventName = requireEventName(environment.eventName);
  const pullRequestHeadSha = eventName === 'pull_request' || eventName === 'workflow_dispatch'
    ? requireCommitSha(environment.pullRequestHeadSha, 'CI_PR_HEAD_SHA')
    : null;
  return {
    schemaVersion: RELEASE_CONTRACT.schemaVersions.evidence,
    sourceSha,
    runId: requirePositiveInteger(environment.runId, 'CI_RUN_ID'),
    runAttempt: requirePositiveInteger(environment.runAttempt, 'CI_RUN_ATTEMPT'),
    eventName,
    pullRequestHeadSha,
    vsixFile,
    vsixSha256: actualDigest,
    releaseEligible: false,
  };
}

export async function writeCiEvidence(
  cwd: string,
  outDir: string,
  environment: CiEvidenceEnvironment,
): Promise<CiEvidence> {
  const artifactDir = resolve(cwd, outDir);
  const evidence = await createCiEvidence(artifactDir, environment);
  await writeFile(join(artifactDir, RELEASE_CONTRACT.bundle.evidence), `${JSON.stringify(evidence, undefined, 2)}\n`, 'utf8');
  return evidence;
}