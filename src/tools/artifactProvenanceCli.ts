import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  ARTIFACT_PROVENANCE_FILE,
  ARTIFACT_SBOM_FILE,
  buildArtifactProvenance,
  buildArtifactSbom,
  parsePackagedIdentity,
  readRuntimeDependencies,
  selectDeliveredRuntimeFiles,
} from './artifactProvenance';
import { readDigestSidecar, readEvidenceFile } from './evidenceFiles';
import { findNormalizedManifestViolation } from './normalizedManifest';
import { bundleFileName, EVIDENCE_FILE, RELEASE_CONTRACT, VSIX_FILE_PATTERN } from './releaseContract';
import { normalizeArtifactOutDir } from './verifyVsix';
import { readVsixArchive } from './vsixArchive';
import { runCliAsEntry } from './cliBootstrap';
import { compareCodeUnits, describeError, sha256Hex } from '../shared';

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

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  }
  catch (error) {
    throw new Error(`${label} is not valid JSON: ${describeError(error)}`, { cause: error });
  }
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
  const vsixFiles = entries.filter(entry => VSIX_FILE_PATTERN.test(entry));
  if (vsixFiles.length !== 1) {
    throw new Error(`artifact directory must contain exactly one VSIX, found ${vsixFiles.length}`);
  }
  const vsixFile = vsixFiles[0];
  const expectedBaseEntries = [
    vsixFile,
    bundleFileName('manifest', vsixFile),
    bundleFileName('digest', vsixFile),
    EVIDENCE_FILE,
  ].sort(compareCodeUnits);
  const actualEntries = [...entries].sort(compareCodeUnits);
  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedBaseEntries)) {
    throw new Error('artifact directory must contain exactly the verified VSIX, evidence, normalized manifest and digest');
  }

  const evidence = await readEvidenceFile(resolvedDir);
  if (evidence.vsixFile !== vsixFile) {
    throw new Error(`${EVIDENCE_FILE} VSIX filename does not match the artifact directory`);
  }
  const vsixBytes = await readFile(join(resolvedDir, vsixFile));
  const artifactSha256 = sha256Hex(vsixBytes);
  if (artifactSha256 !== evidence.vsixSha256) {
    throw new Error(`VSIX bytes do not match ${EVIDENCE_FILE} digest`);
  }
  const sidecarDigest = await readDigestSidecar(resolvedDir, vsixFile);
  if (sidecarDigest !== artifactSha256) {
    throw new Error('VSIX digest sidecar does not match the artifact bytes');
  }
  const archiveEntries = readVsixArchive(vsixBytes);
  const manifestFile = bundleFileName('manifest', vsixFile);
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
    throw new Error(`provenance metadata does not match ${EVIDENCE_FILE} identity`);
  }
  if (eventName !== 'push' && eventName !== 'pull_request' && eventName !== 'workflow_dispatch') {
    throw new Error('PROVENANCE_EVENT_NAME must be push, pull_request or workflow_dispatch');
  }
  const repository = requireEnvironment(environment.repository, 'local/repository', 'PROVENANCE_REPOSITORY');
  const signerWorkflow = requireEnvironment(
    environment.signerWorkflow,
    `${repository}/${RELEASE_CONTRACT.workflows.signerPath}`,
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
    process.stderr.write(`Artifact provenance failed: ${describeError(error)}\n`);
    return 1;
  }
}

/* v8 ignore start -- process bootstrap */
runCliAsEntry(typeof module === 'undefined' ? undefined : module, () => mainArtifactProvenance(process.argv.slice(2), process.cwd(), process.env));
/* v8 ignore stop */