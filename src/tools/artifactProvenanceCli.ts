import { createHash } from 'node:crypto';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  ARTIFACT_PROVENANCE_FILE,
  ARTIFACT_SBOM_FILE,
  buildArtifactProvenance,
  buildArtifactSbom,
  findNormalizedManifestViolation,
  parsePackagedIdentity,
  readRuntimeDependencies,
  selectDeliveredRuntimeFiles,
} from './artifactProvenance';
import { normalizeArtifactOutDir } from './verifyVsix';
import { readVsixArchive } from './vsixArchive';

const SHA256_LINE_PATTERN = /^([0-9a-f]{64}) {2}([^\r\n]+)\n$/u;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const RUN_ID_PATTERN = /^[1-9]\d*$/u;
const SAFE_VSIX_FILE_PATTERN = /^[A-Za-z0-9._-]+\.vsix$/u;

export interface ArtifactProvenanceArgs {
  readonly artifactDir: string;
}

export interface ArtifactProvenanceEnvironment {
  readonly sourceSha?: string;
  readonly ciRunId?: string;
  readonly ciRunAttempt?: string;
  readonly eventName?: string;
  readonly repository?: string;
  readonly signerWorkflow?: string;
}

interface CiEvidence {
  readonly sourceSha: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly eventName: 'push' | 'pull_request' | 'workflow_dispatch';
  readonly pullRequestHeadSha: string | null;
  readonly vsixFile: string;
  readonly vsixSha256: string;
  readonly releaseEligible: false;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  }
  catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const required = [...expected].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    throw new Error(`${label} contains unexpected or missing fields`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function parseEvidence(value: unknown): CiEvidence {
  if (!isRecord(value)) {
    throw new Error('evidence.json must be an object');
  }
  exactKeys(value, [
    'eventName',
    'pullRequestHeadSha',
    'releaseEligible',
    'runAttempt',
    'runId',
    'schemaVersion',
    'sourceSha',
    'vsixFile',
    'vsixSha256',
  ], 'evidence.json');
  if (value.schemaVersion !== 1 || value.releaseEligible !== false) {
    throw new Error('evidence.json must use schemaVersion 1 and releaseEligible=false');
  }
  if (value.eventName !== 'push' && value.eventName !== 'pull_request' && value.eventName !== 'workflow_dispatch') {
    throw new Error('evidence.json has an unsupported eventName');
  }
  const evidence: CiEvidence = {
    sourceSha: requiredString(value.sourceSha, 'evidence.json sourceSha'),
    runId: requiredString(value.runId, 'evidence.json runId'),
    runAttempt: requiredString(value.runAttempt, 'evidence.json runAttempt'),
    eventName: value.eventName,
    pullRequestHeadSha: value.pullRequestHeadSha === null ? null : requiredString(value.pullRequestHeadSha, 'evidence.json pullRequestHeadSha'),
    vsixFile: requiredString(value.vsixFile, 'evidence.json vsixFile'),
    vsixSha256: requiredString(value.vsixSha256, 'evidence.json vsixSha256'),
    releaseEligible: false,
  };
  if (!COMMIT_SHA_PATTERN.test(evidence.sourceSha) || !RUN_ID_PATTERN.test(evidence.runId)
    || !RUN_ID_PATTERN.test(evidence.runAttempt) || !SAFE_VSIX_FILE_PATTERN.test(evidence.vsixFile)
    || !/^[0-9a-f]{64}$/u.test(evidence.vsixSha256)) {
    throw new Error('evidence.json identity fields are malformed');
  }
  if ((evidence.eventName === 'push' && evidence.pullRequestHeadSha !== null)
    || (evidence.eventName !== 'push' && !COMMIT_SHA_PATTERN.test(evidence.pullRequestHeadSha ?? ''))) {
    throw new Error('evidence.json pull request identity does not match eventName');
  }
  return evidence;
}

function parseDigest(contents: string, expectedFile: string): string {
  const match = SHA256_LINE_PATTERN.exec(contents);
  if (match === null || match[2] !== expectedFile) {
    throw new Error(`digest sidecar must contain exactly "<sha256>  ${expectedFile}"`);
  }
  return match[1];
}

function requireEnvironment(value: string | undefined, fallback: string, label: string): string {
  const result = value ?? fallback;
  if (result.length === 0 || /[\u0000-\u001f\u007f]/u.test(result)) {
    throw new Error(`${label} must be a non-empty safe metadata value`);
  }
  return result;
}

export function parseArtifactProvenanceArgs(argv: readonly string[]): ArtifactProvenanceArgs {
  if (argv.length !== 2 || argv[0] !== '--artifact-dir') {
    throw new Error('usage: release:provenance --artifact-dir <relative-directory>');
  }
  return { artifactDir: normalizeArtifactOutDir(argv[1]) };
}

export async function writeArtifactProvenanceBundle(
  cwd: string,
  artifactDir: string,
  environment: ArtifactProvenanceEnvironment = {},
): Promise<{ readonly sourceSha: string; readonly vsixFile: string }> {
  const resolvedDir = resolve(cwd, artifactDir);
  const entries = await readdir(resolvedDir);
  const vsixFiles = entries.filter(entry => SAFE_VSIX_FILE_PATTERN.test(entry));
  if (vsixFiles.length !== 1) {
    throw new Error(`artifact directory must contain exactly one VSIX, found ${vsixFiles.length}`);
  }
  const vsixFile = vsixFiles[0];
  const expectedBaseEntries = [
    vsixFile,
    `${vsixFile}.manifest.txt`,
    `${vsixFile}.sha256`,
    'evidence.json',
  ].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const actualEntries = [...entries].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedBaseEntries)) {
    throw new Error('artifact directory must contain exactly the verified VSIX, evidence, normalized manifest and digest');
  }

  const evidence = parseEvidence(parseJson(await readFile(join(resolvedDir, 'evidence.json')), 'evidence.json'));
  if (evidence.vsixFile !== vsixFile) {
    throw new Error('evidence.json VSIX filename does not match the artifact directory');
  }
  const vsixBytes = await readFile(join(resolvedDir, vsixFile));
  const artifactSha256 = sha256Hex(vsixBytes);
  if (artifactSha256 !== evidence.vsixSha256) {
    throw new Error('VSIX bytes do not match evidence.json digest');
  }
  const sidecarDigest = parseDigest(await readFile(join(resolvedDir, `${vsixFile}.sha256`), 'utf8'), vsixFile);
  if (sidecarDigest !== artifactSha256) {
    throw new Error('VSIX digest sidecar does not match the artifact bytes');
  }
  const archiveEntries = readVsixArchive(vsixBytes);
  const manifestFile = `${vsixFile}.manifest.txt`;
  const manifestContents = await readFile(join(resolvedDir, manifestFile), 'utf8');
  const manifestViolation = findNormalizedManifestViolation(manifestContents, archiveEntries);
  if (manifestViolation !== undefined) {
    throw new Error(manifestViolation);
  }
  const packagedManifestEntry = archiveEntries.find(entry => entry.path === 'extension/package.json');
  if (packagedManifestEntry === undefined) {
    throw new Error('VSIX must contain extension/package.json for the SBOM');
  }
  const packagedManifest = parseJson(packagedManifestEntry.bytes, 'extension/package.json');
  const identity = parsePackagedIdentity(packagedManifestEntry.bytes);
  const runtimeFiles = selectDeliveredRuntimeFiles(archiveEntries);
  const runtimeDependencies = readRuntimeDependencies(packagedManifest);
  const sbom = buildArtifactSbom({
    identity,
    artifactFile: vsixFile,
    artifactSha256,
    runtimeFiles,
    dependencies: runtimeDependencies.dependencies,
    optionalDependencies: runtimeDependencies.optionalDependencies,
  });
  const sbomContents = `${JSON.stringify(sbom, undefined, 2)}\n`;
  const sbomSha256 = sha256Hex(new TextEncoder().encode(sbomContents));
  const sourceSha = requireEnvironment(environment.sourceSha, evidence.sourceSha, 'PROVENANCE_SOURCE_SHA');
  const ciRunId = requireEnvironment(environment.ciRunId, evidence.runId, 'PROVENANCE_CI_RUN_ID');
  const ciRunAttempt = requireEnvironment(environment.ciRunAttempt, evidence.runAttempt, 'PROVENANCE_CI_RUN_ATTEMPT');
  const eventName = requireEnvironment(environment.eventName, evidence.eventName, 'PROVENANCE_EVENT_NAME');
  if (sourceSha !== evidence.sourceSha || ciRunId !== evidence.runId || ciRunAttempt !== evidence.runAttempt || eventName !== evidence.eventName) {
    throw new Error('provenance metadata does not match evidence.json identity');
  }
  if (eventName !== 'push' && eventName !== 'pull_request' && eventName !== 'workflow_dispatch') {
    throw new Error('PROVENANCE_EVENT_NAME must be push, pull_request or workflow_dispatch');
  }
  const repository = requireEnvironment(environment.repository, 'local/repository', 'PROVENANCE_REPOSITORY');
  const signerWorkflow = requireEnvironment(
    environment.signerWorkflow,
    `${repository}/.github/workflows/ci.yml`,
    'PROVENANCE_SIGNER_WORKFLOW',
  );
  const provenance = buildArtifactProvenance({
    sourceSha,
    ciRunId,
    ciRunAttempt,
    eventName,
    repository,
    signerWorkflow,
    artifactFile: vsixFile,
    artifactSha256,
    manifestFile,
    manifestSha256: sha256Hex(new TextEncoder().encode(manifestContents)),
    sbomFile: ARTIFACT_SBOM_FILE,
    sbomSha256,
  });
  const provenanceContents = `${JSON.stringify(provenance, undefined, 2)}\n`;
  const generated = [join(resolvedDir, ARTIFACT_SBOM_FILE), join(resolvedDir, ARTIFACT_PROVENANCE_FILE)];
  try {
    await writeFile(generated[0], sbomContents, 'utf8');
    await writeFile(generated[1], provenanceContents, 'utf8');
  }
  catch (error) {
    await Promise.all(generated.map(file => rm(file, { force: true })));
    throw error;
  }
  return { sourceSha, vsixFile };
}

export async function mainArtifactProvenance(
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  try {
    const { artifactDir } = parseArtifactProvenanceArgs(argv);
    const result = await writeArtifactProvenanceBundle(cwd, artifactDir, {
      sourceSha: env.PROVENANCE_SOURCE_SHA,
      ciRunId: env.PROVENANCE_CI_RUN_ID,
      ciRunAttempt: env.PROVENANCE_CI_RUN_ATTEMPT,
      eventName: env.PROVENANCE_EVENT_NAME,
      repository: env.PROVENANCE_REPOSITORY,
      signerWorkflow: env.PROVENANCE_SIGNER_WORKFLOW,
    });
    process.stdout.write(`Provenance recorded for ${result.sourceSha}: ${result.vsixFile}\n`);
    return 0;
  }
  catch (error) {
    process.stderr.write(`Artifact provenance failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/* v8 ignore start -- process bootstrap */
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void mainArtifactProvenance(process.argv.slice(2), process.cwd(), process.env).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
/* v8 ignore stop */