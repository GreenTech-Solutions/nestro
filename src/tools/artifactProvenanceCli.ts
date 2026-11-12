import { readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { normalizeArtifactOutDir } from './artifactOutDir';
import {
  ARTIFACT_PROVENANCE_FILE,
  ARTIFACT_SBOM_FILE,
  buildArtifactProvenance,
} from './artifactProvenance';
import type { ArtifactProvenanceInput } from './artifactProvenance';
import { buildArtifactSbom } from './artifactSbom';
import { readVerifiedVsix } from './evidenceBundle';
import { readEvidenceFile } from './evidenceFiles';
import type { CiEvidence } from './evidenceFiles';
import { readPackagedSbomInputs } from './packagedRuntime';
import { bundleFileName, EVIDENCE_FILE, RELEASE_CONTRACT, VSIX_FILE_PATTERN } from './releaseContract';
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

type ProvenanceMetadata = Pick<ArtifactProvenanceInput, 'sourceSha' | 'ciRunId' | 'ciRunAttempt' | 'eventName' | 'repository' | 'signerWorkflow'>;

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

/** Requires the directory to hold exactly the verified VSIX, evidence, manifest and digest, and returns the VSIX name. */
async function findVerifiedVsixFile(artifactDir: string): Promise<string> {
  const entries = await readdir(artifactDir);
  const vsixFiles = entries.filter(entry => VSIX_FILE_PATTERN.test(entry));
  if (vsixFiles.length !== 1) {
    throw new Error(`artifact directory must contain exactly one VSIX, found ${vsixFiles.length}`);
  }
  const vsixFile = vsixFiles[0];
  const expectedEntries = [
    vsixFile,
    bundleFileName('manifest', vsixFile),
    bundleFileName('digest', vsixFile),
    EVIDENCE_FILE,
  ].sort(compareCodeUnits);
  if (JSON.stringify([...entries].sort(compareCodeUnits)) !== JSON.stringify(expectedEntries)) {
    throw new Error('artifact directory must contain exactly the verified VSIX, evidence, normalized manifest and digest');
  }
  return vsixFile;
}

/** Resolves the CI identity from the environment, which must agree with `evidence.json`. */
function readProvenanceMetadata(environment: ArtifactProvenanceEnvironment, evidence: CiEvidence): ProvenanceMetadata {
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
  return { sourceSha, ciRunId, ciRunAttempt, eventName, repository, signerWorkflow };
}

export async function writeArtifactProvenanceBundle(
  cwd: string,
  artifactDir: string,
  environment: ArtifactProvenanceEnvironment = {},
): Promise<{ readonly sourceSha: string; readonly vsixFile: string }> {
  const resolvedDir = resolve(cwd, artifactDir);
  const vsixFile = await findVerifiedVsixFile(resolvedDir);
  const evidence = await readEvidenceFile(resolvedDir);
  if (evidence.vsixFile !== vsixFile) {
    throw new Error(`${EVIDENCE_FILE} VSIX filename does not match the artifact directory`);
  }
  const vsix = await readVerifiedVsix(resolvedDir, evidence);
  const sbomContents = `${JSON.stringify(buildArtifactSbom({
    ...readPackagedSbomInputs(vsix.archiveEntries),
    artifactFile: vsixFile,
    artifactSha256: evidence.vsixSha256,
  }), undefined, 2)}\n`;
  const metadata = readProvenanceMetadata(environment, evidence);
  const provenance = buildArtifactProvenance({
    ...metadata,
    artifactFile: vsixFile,
    artifactSha256: evidence.vsixSha256,
    manifestFile: vsix.manifestFile,
    manifestSha256: vsix.manifestSha256,
    sbomFile: ARTIFACT_SBOM_FILE,
    sbomSha256: sha256Hex(sbomContents),
  });
  const generated = [join(resolvedDir, ARTIFACT_SBOM_FILE), join(resolvedDir, ARTIFACT_PROVENANCE_FILE)];
  try {
    await writeFile(generated[0], sbomContents, 'utf8');
    await writeFile(generated[1], `${JSON.stringify(provenance, undefined, 2)}\n`, 'utf8');
  }
  catch (error) {
    await Promise.all(generated.map(file => rm(file, { force: true })));
    throw error;
  }
  return { sourceSha: metadata.sourceSha, vsixFile };
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