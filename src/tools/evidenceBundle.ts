import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ARTIFACT_PROVENANCE_FILE, ARTIFACT_SBOM_FILE, findArtifactProvenanceViolation } from './artifactProvenance';
import type { ArtifactProvenance } from './artifactProvenance';
import { findArtifactSbomViolation } from './artifactSbom';
import { readDigestSidecar } from './evidenceFiles';
import type { CiEvidence } from './evidenceFiles';
import { findNormalizedManifestViolation } from './normalizedManifest';
import { readPackagedSbomInputs } from './packagedRuntime';
import { bundleFileName, bundleMemberNames, EVIDENCE_FILE } from './releaseContract';
import type { ReleaseCandidateArtifact } from './releaseCandidate';
import { readVsixArchive } from './vsixArchive';
import type { VsixArchiveEntry } from './vsixArchive';
import { compareCodeUnits, describeError, sha256Hex } from '../shared';

/** A VSIX proven to match its evidence, digest sidecar and normalized manifest. */
export interface VerifiedVsix {
  readonly vsixBytes: Uint8Array;
  readonly archiveEntries: readonly VsixArchiveEntry[];
  readonly manifestFile: string;
  readonly manifestSha256: string;
}

/** Where the provenance document claims to come from; read from the document itself when omitted. */
export interface ProvenanceOrigin {
  readonly repository: string;
  readonly signerWorkflow: string;
}

function parseJsonBytes(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  }
  catch (error) {
    throw new Error(`${label} is not valid JSON: ${describeError(error)}`, { cause: error });
  }
}

/** Reads the VSIX in `artifactDir` and proves it against `evidence.json`, the digest sidecar and the manifest. */
export async function readVerifiedVsix(artifactDir: string, evidence: CiEvidence): Promise<VerifiedVsix> {
  const vsixBytes = await readFile(join(artifactDir, evidence.vsixFile));
  if (sha256Hex(vsixBytes) !== evidence.vsixSha256) {
    throw new Error(`VSIX bytes do not match ${EVIDENCE_FILE} digest`);
  }
  if (await readDigestSidecar(artifactDir, evidence.vsixFile) !== evidence.vsixSha256) {
    throw new Error(`VSIX digest sidecar does not match ${EVIDENCE_FILE}`);
  }
  const archiveEntries = readVsixArchive(vsixBytes);
  const manifestFile = bundleFileName('manifest', evidence.vsixFile);
  const manifestContents = await readFile(join(artifactDir, manifestFile), 'utf8');
  const manifestViolation = findNormalizedManifestViolation(manifestContents, archiveEntries);
  if (manifestViolation !== undefined) {
    throw new Error(manifestViolation);
  }
  return { vsixBytes, archiveEntries, manifestFile, manifestSha256: sha256Hex(manifestContents) };
}

async function readVerifiedSbom(artifactDir: string, evidence: CiEvidence, vsix: VerifiedVsix): Promise<Uint8Array> {
  const sbomBytes = await readFile(join(artifactDir, ARTIFACT_SBOM_FILE));
  const violation = findArtifactSbomViolation(parseJsonBytes(sbomBytes, ARTIFACT_SBOM_FILE), {
    ...readPackagedSbomInputs(vsix.archiveEntries),
    artifactFile: evidence.vsixFile,
    artifactSha256: evidence.vsixSha256,
  });
  if (violation !== undefined) {
    throw new Error(violation);
  }
  return sbomBytes;
}

function readProvenanceOrigin(provenance: unknown): ProvenanceOrigin {
  const violation = findArtifactProvenanceViolation(provenance);
  if (violation !== undefined) {
    throw new Error(violation);
  }
  const { repository, signerWorkflow } = provenance as ArtifactProvenance;
  return { repository, signerWorkflow };
}

async function readVerifiedProvenance(
  artifactDir: string,
  evidence: CiEvidence,
  vsix: VerifiedVsix,
  sbomSha256: string,
  origin: ProvenanceOrigin | undefined,
): Promise<Uint8Array> {
  const provenanceBytes = await readFile(join(artifactDir, ARTIFACT_PROVENANCE_FILE));
  const provenance = parseJsonBytes(provenanceBytes, ARTIFACT_PROVENANCE_FILE);
  const violation = findArtifactProvenanceViolation(provenance, {
    sourceSha: evidence.sourceSha,
    ciRunId: evidence.runId,
    ciRunAttempt: evidence.runAttempt,
    eventName: evidence.eventName,
    ...(origin ?? readProvenanceOrigin(provenance)),
    artifactFile: evidence.vsixFile,
    artifactSha256: evidence.vsixSha256,
    manifestFile: vsix.manifestFile,
    manifestSha256: vsix.manifestSha256,
    sbomFile: ARTIFACT_SBOM_FILE,
    sbomSha256,
  });
  if (violation !== undefined) {
    throw new Error(violation);
  }
  return provenanceBytes;
}

/**
 * Proves a downloaded six-member evidence bundle is internally consistent: exactly its members,
 * the VSIX matching evidence and sidecar, the normalized manifest, and an SBOM and provenance
 * that are exactly what the evidence and the archive imply.
 */
export async function verifyEvidenceBundle(
  artifactDir: string,
  evidence: CiEvidence,
  origin?: ProvenanceOrigin,
): Promise<ReleaseCandidateArtifact> {
  const entries = (await readdir(artifactDir)).sort(compareCodeUnits);
  const expectedEntries = bundleMemberNames('verify', evidence.vsixFile).sort(compareCodeUnits);
  if (JSON.stringify(entries) !== JSON.stringify(expectedEntries)) {
    throw new Error('evidence bundle must contain exactly the six-member provenance bundle');
  }
  const vsix = await readVerifiedVsix(artifactDir, evidence);
  const sbomBytes = await readVerifiedSbom(artifactDir, evidence, vsix);
  const sbomSha256 = sha256Hex(sbomBytes);
  const provenanceBytes = await readVerifiedProvenance(artifactDir, evidence, vsix, sbomSha256, origin);
  return {
    vsixFile: evidence.vsixFile,
    digestFile: bundleFileName('digest', evidence.vsixFile),
    digest: evidence.vsixSha256,
    manifestFile: vsix.manifestFile,
    manifestSha256: vsix.manifestSha256,
    sbomFile: ARTIFACT_SBOM_FILE,
    sbomSha256,
    provenanceFile: ARTIFACT_PROVENANCE_FILE,
    provenanceSha256: sha256Hex(provenanceBytes),
  };
}