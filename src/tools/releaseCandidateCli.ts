import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFile, copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  ARTIFACT_PROVENANCE_FILE,
  ARTIFACT_SBOM_FILE,
  findArtifactProvenanceViolation,
  findArtifactSbomViolation,
  findNormalizedManifestViolation,
  parsePackagedIdentity,
  readRuntimeDependencies,
  selectDeliveredRuntimeFiles,
} from './artifactProvenance';
import { buildReleaseCandidate } from './releaseCandidate';
import type { ReleaseCandidateArtifact, ReleaseCandidateEvidence } from './releaseCandidate';
import { normalizeArtifactOutDir } from './verifyVsix';
import { readVsixArchive } from './vsixArchive';

const execFileAsync = promisify(execFile);
const SHA256_LINE_PATTERN = /^([0-9a-f]{64}) {2}([^\r\n]+)\n$/u;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const RUN_ID_PATTERN = /^[1-9]\d*$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const VSIX_FILE_PATTERN = /^[A-Za-z0-9._-]+\.vsix$/u;

export interface ReleaseCandidateArgs {
  readonly artifactDir: string;
  readonly outDir: string;
}

export function parseReleaseCandidateArgs(argv: readonly string[]): ReleaseCandidateArgs {
  if (argv.length !== 4 || argv[0] !== '--artifact-dir' || argv[2] !== '--out-dir') {
    throw new Error('usage: release:candidate --artifact-dir <dir> --out-dir <dir>');
  }
  return { artifactDir: normalizeArtifactOutDir(argv[1]), outDir: normalizeArtifactOutDir(argv[3]) };
}

function requireExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort((left, right) => left.localeCompare(right));
  const required = [...expected].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    throw new Error(`${label} contains unexpected or missing fields`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`evidence.json must carry ${label} as a non-empty string`);
  }
  return value;
}

function readRequiredEvidence(source: unknown): ReleaseCandidateEvidence {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new Error('evidence.json must be an object');
  }
  const record = source as Record<string, unknown>;
  requireExactKeys(record, [
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
  if (record.schemaVersion !== 1) {
    throw new Error('evidence.json must use schemaVersion 1');
  }
  if (record.eventName !== 'push') {
    throw new Error('evidence.json must come from a push run');
  }
  if (record.pullRequestHeadSha !== null) {
    throw new Error('evidence.json must have a null pull request head for a push run');
  }
  if (record.releaseEligible !== false) {
    throw new Error('evidence.json must set releaseEligible=false');
  }
  const sourceSha = requireString(record.sourceSha, 'sourceSha');
  const runId = requireString(record.runId, 'runId');
  const runAttempt = requireString(record.runAttempt, 'runAttempt');
  const vsixFile = requireString(record.vsixFile, 'vsixFile');
  const vsixSha256 = requireString(record.vsixSha256, 'vsixSha256');
  if (!COMMIT_SHA_PATTERN.test(sourceSha)) {
    throw new Error('evidence.json sourceSha must be a full lowercase 40-character commit SHA');
  }
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error('evidence.json runId must be a positive integer');
  }
  if (!RUN_ID_PATTERN.test(runAttempt)) {
    throw new Error('evidence.json runAttempt must be a positive integer');
  }
  if (!VSIX_FILE_PATTERN.test(vsixFile)) {
    throw new Error('evidence.json vsixFile must be a safe .vsix filename');
  }
  if (!/^[0-9a-f]{64}$/u.test(vsixSha256)) {
    throw new Error('evidence.json vsixSha256 must be a lowercase SHA-256 digest');
  }
  return {
    sourceSha,
    runId,
    runAttempt,
    vsixFile,
    vsixSha256,
    eventName: record.eventName,
    pullRequestHeadSha: null,
    releaseEligible: false,
  };
}

async function listExistingTags(cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['tag', '-l', 'v*'], { cwd });
  return stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0);
}

async function readReleaseNotes(cwd: string, version: string): Promise<string> {
  const source = await readFile(resolve(cwd, 'CHANGELOG.md'), 'utf8');
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const heading = new RegExp(`^## \\[${escapedVersion}\\]\\([^\\n]+\\)\\s*\\([^\\n]+\\)\\s*$`, 'mu');
  const match = heading.exec(source);
  if (match === null) {
    throw new Error(`CHANGELOG.md is missing the generated ${version} entry`);
  }
  const contentStart = match.index + match[0].length;
  const remaining = source.slice(contentStart);
  const nextHeading = /^## /mu.exec(remaining);
  const body = remaining.slice(0, nextHeading?.index ?? remaining.length).trim();
  if (body.length === 0) {
    throw new Error(`CHANGELOG.md has no release notes for ${version}`);
  }
  return body;
}

async function readPackageVersion(cwd: string): Promise<string> {
  let source: string;
  try {
    source = await readFile(resolve(cwd, 'package.json'), 'utf8');
  }
  catch (error) {
    throw new Error(`package.json could not be read: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  }
  catch (error) {
    throw new Error(`package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || typeof (value as Record<string, unknown>).version !== 'string'
    || !VERSION_PATTERN.test((value as Record<string, unknown>).version as string)) {
    throw new Error('package.json must declare a plain major.minor.patch version');
  }
  return (value as Record<string, unknown>).version as string;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  }
  catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function expectedBundleEntries(vsixFile: string, includeEvidence: boolean): string[] {
  return [
    ...(includeEvidence ? ['evidence.json'] : ['candidate.json']),
    vsixFile,
    `${vsixFile}.manifest.txt`,
    `${vsixFile}.sha256`,
    ARTIFACT_PROVENANCE_FILE,
    ARTIFACT_SBOM_FILE,
  ].sort((left, right) => left.localeCompare(right));
}

async function verifyEvidenceFiles(
  artifactDir: string,
  evidence: ReleaseCandidateEvidence,
  environment: NodeJS.ProcessEnv,
): Promise<ReleaseCandidateArtifact> {
  const entries = (await readdir(artifactDir)).sort((left, right) => left.localeCompare(right));
  const expectedEntries = expectedBundleEntries(evidence.vsixFile, true);
  if (JSON.stringify(entries) !== JSON.stringify(expectedEntries)) {
    throw new Error('verified evidence must contain exactly the six-member provenance bundle');
  }
  const vsixBytes = await readFile(resolve(artifactDir, evidence.vsixFile));
  const actualDigest = sha256Hex(vsixBytes);
  if (actualDigest !== evidence.vsixSha256) {
    throw new Error('candidate VSIX digest does not match evidence.json');
  }
  const digestFile = `${evidence.vsixFile}.sha256`;
  const digestMatch = SHA256_LINE_PATTERN.exec(await readFile(resolve(artifactDir, digestFile), 'utf8'));
  if (digestMatch === null || digestMatch[2] !== evidence.vsixFile || digestMatch[1] !== evidence.vsixSha256) {
    throw new Error('candidate evidence digest sidecar does not match evidence.json');
  }
  const archiveEntries = readVsixArchive(vsixBytes);
  const manifestFile = `${evidence.vsixFile}.manifest.txt`;
  const manifestContents = await readFile(resolve(artifactDir, manifestFile), 'utf8');
  const manifestViolation = findNormalizedManifestViolation(manifestContents, archiveEntries);
  if (manifestViolation !== undefined) {
    throw new Error(manifestViolation);
  }
  const packagedManifest = archiveEntries.find(entry => entry.path === 'extension/package.json');
  if (packagedManifest === undefined) {
    throw new Error('VSIX must contain extension/package.json');
  }
  const identity = parsePackagedIdentity(packagedManifest.bytes);
  const runtimeFiles = selectDeliveredRuntimeFiles(archiveEntries);
  const runtimeDependencies = readRuntimeDependencies(parseJson(packagedManifest.bytes, 'extension/package.json'));
  const manifestSha256 = sha256Hex(new TextEncoder().encode(manifestContents));
  const sbomBytes = await readFile(resolve(artifactDir, ARTIFACT_SBOM_FILE));
  const sbomSha256 = sha256Hex(sbomBytes);
  const sbom = parseJson(sbomBytes, ARTIFACT_SBOM_FILE);
  const sbomViolation = findArtifactSbomViolation(sbom, {
    identity,
    artifactFile: evidence.vsixFile,
    artifactSha256: evidence.vsixSha256,
    runtimeFiles,
    dependencies: runtimeDependencies.dependencies,
    optionalDependencies: runtimeDependencies.optionalDependencies,
  });
  if (sbomViolation !== undefined) {
    throw new Error(sbomViolation);
  }
  const provenanceBytes = await readFile(resolve(artifactDir, ARTIFACT_PROVENANCE_FILE));
  const provenance = parseJson(provenanceBytes, ARTIFACT_PROVENANCE_FILE);
  const provenanceViolation = findArtifactProvenanceViolation(provenance, {
    sourceSha: evidence.sourceSha,
    ciRunId: evidence.runId,
    ciRunAttempt: evidence.runAttempt,
    eventName: 'push',
    repository: environment.RELEASE_REPOSITORY ?? 'local/repository',
    signerWorkflow: environment.RELEASE_SIGNER_WORKFLOW ?? `${environment.RELEASE_REPOSITORY ?? 'local/repository'}/.github/workflows/ci.yml`,
    artifactFile: evidence.vsixFile,
    artifactSha256: evidence.vsixSha256,
    manifestFile,
    manifestSha256,
    sbomFile: ARTIFACT_SBOM_FILE,
    sbomSha256,
  });
  if (provenanceViolation !== undefined) {
    throw new Error(provenanceViolation);
  }
  return {
    vsixFile: evidence.vsixFile,
    digestFile,
    digest: evidence.vsixSha256,
    manifestFile,
    manifestSha256,
    sbomFile: ARTIFACT_SBOM_FILE,
    sbomSha256,
    provenanceFile: ARTIFACT_PROVENANCE_FILE,
    provenanceSha256: sha256Hex(provenanceBytes),
  };
}

async function writeGithubOutput(path: string | undefined, key: string, value: string): Promise<void> {
  if (path === undefined) {
    return;
  }
  await appendFile(path, `${key}=${value}\n`, 'utf8');
}

export async function mainReleaseCandidate(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  try {
    const { artifactDir, outDir } = parseReleaseCandidateArgs(argv);
    const resolvedArtifactDir = resolve(cwd, artifactDir);
    const resolvedOutDir = resolve(cwd, outDir);
    const evidenceSource = JSON.parse(await readFile(resolve(resolvedArtifactDir, 'evidence.json'), 'utf8')) as unknown;
    const evidence = readRequiredEvidence(evidenceSource);
    if (evidence.eventName !== 'push' || evidence.pullRequestHeadSha !== null || evidence.releaseEligible !== false) {
      throw new Error('candidate input must be successful push evidence with releaseEligible=false');
    }
    const expectedSourceSha = env.RELEASE_SOURCE_SHA;
    if (expectedSourceSha !== undefined && (!COMMIT_SHA_PATTERN.test(expectedSourceSha) || evidence.sourceSha !== expectedSourceSha)) {
      throw new Error('candidate evidence source SHA does not match the upstream workflow run');
    }
    const expectedCiRunId = env.RELEASE_CI_RUN_ID;
    if (expectedCiRunId !== undefined && (!RUN_ID_PATTERN.test(expectedCiRunId) || evidence.runId !== expectedCiRunId)) {
      throw new Error('candidate evidence run ID does not match the upstream workflow run');
    }
    const candidateRunId = env.RELEASE_CANDIDATE_RUN_ID;
    if (candidateRunId === undefined || !RUN_ID_PATTERN.test(candidateRunId)) {
      throw new Error('RELEASE_CANDIDATE_RUN_ID must be a positive integer');
    }
    const artifact = await verifyEvidenceFiles(resolvedArtifactDir, evidence, env);
    const packageVersion = await readPackageVersion(cwd);
    const existingTags = await listExistingTags(cwd);
    const notes = await readReleaseNotes(cwd, packageVersion);
    const outcome = buildReleaseCandidate(evidence, packageVersion, existingTags, notes, {
      expectedSourceSha,
      expectedCiRunId,
      candidateRunId,
      artifact,
    });
    if (!outcome.isCandidate) {
      await writeGithubOutput(env.GITHUB_OUTPUT, 'is-candidate', 'false');
      process.stdout.write(`No release candidate: ${outcome.reason}\n`);
      return 0;
    }
    await mkdir(resolvedOutDir, { recursive: true });
    const outputEntries = await readdir(resolvedOutDir);
    if (outputEntries.length > 0) {
      throw new Error('release candidate output directory must be empty');
    }
    for (const file of [artifact.vsixFile, artifact.manifestFile, artifact.digestFile, artifact.sbomFile, artifact.provenanceFile]) {
      await copyFile(resolve(resolvedArtifactDir, file), resolve(resolvedOutDir, file));
    }
    await writeFile(resolve(resolvedOutDir, 'candidate.json'), `${JSON.stringify(outcome.manifest, undefined, 2)}\n`, 'utf8');
    await writeGithubOutput(env.GITHUB_OUTPUT, 'is-candidate', 'true');
    await writeGithubOutput(env.GITHUB_OUTPUT, 'version', outcome.manifest.version);
    await writeGithubOutput(env.GITHUB_OUTPUT, 'artifact-name', `release-candidate-${outcome.manifest.version}-${outcome.manifest.sourceSha}`);
    process.stdout.write(`Release candidate v${outcome.manifest.version} ready\n`);
    return 0;
  }
  catch (error) {
    process.stderr.write(`Release candidate failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/* v8 ignore start -- process bootstrap */
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void mainReleaseCandidate(process.argv.slice(2), process.cwd(), process.env).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
/* v8 ignore stop */