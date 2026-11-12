import { execFile } from 'node:child_process';
import { appendFile, copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { normalizeArtifactOutDir } from './artifactOutDir';
import { verifyEvidenceBundle } from './evidenceBundle';
import type { ProvenanceOrigin } from './evidenceBundle';
import { COMMIT_SHA_PATTERN, POSITIVE_INTEGER_PATTERN, readEvidenceFile } from './evidenceFiles';
import { buildReleaseCandidate } from './releaseCandidate';
import { CANDIDATE_FILE, EVIDENCE_FILE, RELEASE_CONTRACT } from './releaseContract';
import { runCliAsEntry } from './cliBootstrap';
import { describeError, isPlainNumericSemver, isRecord } from '../shared';

const execFileAsync = promisify(execFile);

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
    throw new Error(`package.json could not be read: ${describeError(error)}`, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  }
  catch (error) {
    throw new Error(`package.json is not valid JSON: ${describeError(error)}`, { cause: error });
  }
  if (!isRecord(value) || typeof value.version !== 'string' || !isPlainNumericSemver(value.version)) {
    throw new Error('package.json must declare a plain major.minor.patch version');
  }
  return value.version;
}

function resolveProvenanceOrigin(environment: NodeJS.ProcessEnv): ProvenanceOrigin {
  const repository = environment.RELEASE_REPOSITORY ?? 'local/repository';
  return {
    repository,
    signerWorkflow: environment.RELEASE_SIGNER_WORKFLOW ?? `${repository}/${RELEASE_CONTRACT.workflows.signerPath}`,
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
    const evidence = await readEvidenceFile(resolvedArtifactDir);
    if (evidence.eventName !== 'push') {
      throw new Error(`${EVIDENCE_FILE} must come from a push run`);
    }
    const expectedSourceSha = env.RELEASE_SOURCE_SHA;
    if (expectedSourceSha !== undefined && (!COMMIT_SHA_PATTERN.test(expectedSourceSha) || evidence.sourceSha !== expectedSourceSha)) {
      throw new Error('candidate evidence source SHA does not match the upstream workflow run');
    }
    const expectedCiRunId = env.RELEASE_CI_RUN_ID;
    if (expectedCiRunId !== undefined && (!POSITIVE_INTEGER_PATTERN.test(expectedCiRunId) || evidence.runId !== expectedCiRunId)) {
      throw new Error('candidate evidence run ID does not match the upstream workflow run');
    }
    const candidateRunId = env.RELEASE_CANDIDATE_RUN_ID;
    if (candidateRunId === undefined || !POSITIVE_INTEGER_PATTERN.test(candidateRunId)) {
      throw new Error('RELEASE_CANDIDATE_RUN_ID must be a positive integer');
    }
    const artifact = await verifyEvidenceBundle(resolvedArtifactDir, evidence, resolveProvenanceOrigin(env));
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
    await writeFile(resolve(resolvedOutDir, CANDIDATE_FILE), `${JSON.stringify(outcome.manifest, undefined, 2)}\n`, 'utf8');
    await writeGithubOutput(env.GITHUB_OUTPUT, 'is-candidate', 'true');
    await writeGithubOutput(env.GITHUB_OUTPUT, 'version', outcome.manifest.version);
    await writeGithubOutput(env.GITHUB_OUTPUT, 'artifact-name', `${RELEASE_CONTRACT.artifactPrefixes.releaseCandidate}${outcome.manifest.version}-${outcome.manifest.sourceSha}`);
    process.stdout.write(`Release candidate v${outcome.manifest.version} ready\n`);
    return 0;
  }
  catch (error) {
    process.stderr.write(`Release candidate failed: ${describeError(error)}\n`);
    return 1;
  }
}

/* v8 ignore start -- process bootstrap */
runCliAsEntry(typeof module === 'undefined' ? undefined : module, () => mainReleaseCandidate(process.argv.slice(2), process.cwd(), process.env));
/* v8 ignore stop */