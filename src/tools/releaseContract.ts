import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describeError, isRecord } from '../shared';

export const RELEASE_CONTRACT_PATH = '.github/release-contract.json';

const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SUFFIX_PATTERN = /^\.[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/u;
const PREFIX_PATTERN = /^[a-z][a-z0-9-]*-$/u;
const WORKFLOW_PATH_PATTERN = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/u;
const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/u;
const HTTPS_ORIGIN_PATTERN = /^https:\/\/[a-z0-9.-]+$/u;
const DOWNLOAD_PATH_PATTERN = /^\/[A-Za-z0-9_./{}-]+$/u;
const REPOSITORY_ROOT = resolve(__dirname, '../..');

export type BundleRole = 'vsix' | 'manifest' | 'digest' | 'evidence' | 'sbom' | 'provenance' | 'candidate';
export type BundleKind = 'verify' | 'candidate';
export type RegistryName = 'marketplace' | 'openVsx';

const BUNDLE_ROLES: readonly BundleRole[] = ['vsix', 'manifest', 'digest', 'evidence', 'sbom', 'provenance', 'candidate'];

export interface ReleaseContract {
  readonly artifactPrefixes: { readonly releaseCandidate: string; readonly verifyEvidence: string };
  readonly bundle: {
    readonly candidate: string;
    readonly candidateMembers: readonly BundleRole[];
    readonly digestSuffix: string;
    readonly evidence: string;
    readonly manifestSuffix: string;
    readonly provenance: string;
    readonly sbom: string;
    readonly verifyMembers: readonly BundleRole[];
    readonly vsixExtension: string;
  };
  readonly candidateKeys: readonly string[];
  readonly registries: Readonly<Record<RegistryName, { readonly downloadPath: string; readonly url: string }>>;
  readonly schemaVersions: { readonly candidate: number; readonly evidence: number; readonly provenance: number };
  readonly secrets: { readonly marketplace: string; readonly openVsx: string; readonly rejectedAliases: readonly string[] };
  readonly vsixBudget: {
    readonly baselineCompressedBytes: number;
    readonly baselinePackagedFileCount: number;
    readonly compressedHeadroomPercent: number;
    readonly maxEntryBytes: number;
    readonly maxUncompressedBytes: number;
    readonly packagedFileCountHeadroom: number;
  };
  readonly workflows: { readonly releaseCandidateName: string; readonly signerPath: string; readonly verifyName: string };
}

type UnknownRecord = Record<string, unknown>;

function contractError(detail: string): Error {
  return new Error(`${RELEASE_CONTRACT_PATH}: ${detail}`);
}

function exactRecord(value: unknown, expected: readonly string[], label: string): UnknownRecord {
  const actual = isRecord(value) ? Object.keys(value).sort((left, right) => left.localeCompare(right)) : [];
  if (!isRecord(value) || actual.join() !== [...expected].sort((left, right) => left.localeCompare(right)).join()) {
    throw contractError(`${label} must contain exactly ${expected.join(', ')}`);
  }
  return value;
}

function section(parent: UnknownRecord, key: string, expected: readonly string[]): UnknownRecord {
  return exactRecord(parent[key], expected, key);
}

function isBundleRole(value: string): value is BundleRole {
  return BUNDLE_ROLES.some(role => role === value);
}

function text(parent: UnknownRecord, key: string, pattern: RegExp, label: string): string {
  const value = parent[key];
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw contractError(`${label}.${key} is malformed`);
  }
  return value;
}

function integer(parent: UnknownRecord, key: string, minimum: number, label: string): number {
  const value = parent[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw contractError(`${label}.${key} must be an integer of at least ${minimum}`);
  }
  return value;
}

function list(parent: UnknownRecord, key: string, accept: (entry: string) => boolean, label: string): string[] {
  const value = parent[key];
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length
    || !value.every((entry): entry is string => typeof entry === 'string' && accept(entry))) {
    throw contractError(`${label}.${key} must be a non-empty list of unique valid entries`);
  }
  return value;
}

function parseBundle(root: UnknownRecord): ReleaseContract['bundle'] {
  const bundle = section(root, 'bundle', ['candidate', 'candidateMembers', 'digestSuffix', 'evidence', 'manifestSuffix', 'provenance', 'sbom', 'verifyMembers', 'vsixExtension']);
  const roles = (key: string): BundleRole[] => list(bundle, key, isBundleRole, 'bundle').filter(isBundleRole);
  const parsed = {
    candidate: text(bundle, 'candidate', FILE_NAME_PATTERN, 'bundle'),
    candidateMembers: roles('candidateMembers'),
    digestSuffix: text(bundle, 'digestSuffix', SUFFIX_PATTERN, 'bundle'),
    evidence: text(bundle, 'evidence', FILE_NAME_PATTERN, 'bundle'),
    manifestSuffix: text(bundle, 'manifestSuffix', SUFFIX_PATTERN, 'bundle'),
    provenance: text(bundle, 'provenance', FILE_NAME_PATTERN, 'bundle'),
    sbom: text(bundle, 'sbom', FILE_NAME_PATTERN, 'bundle'),
    verifyMembers: roles('verifyMembers'),
    vsixExtension: text(bundle, 'vsixExtension', SUFFIX_PATTERN, 'bundle'),
  };
  const fixedNames = [parsed.candidate, parsed.evidence, parsed.provenance, parsed.sbom];
  if (new Set(fixedNames).size !== fixedNames.length
    || parsed.candidateMembers.includes('evidence') || parsed.verifyMembers.includes('candidate')
    || !parsed.candidateMembers.includes('vsix') || !parsed.verifyMembers.includes('vsix')) {
    throw contractError('bundle must name distinct files and keep evidence and candidate in their own bundle');
  }
  return parsed;
}

function parseRegistry(root: UnknownRecord, name: RegistryName): { readonly downloadPath: string; readonly url: string } {
  const registries = section(root, 'registries', ['marketplace', 'openVsx']);
  const registry = section(registries, name, ['downloadPath', 'url']);
  return {
    downloadPath: text(registry, 'downloadPath', DOWNLOAD_PATH_PATTERN, `registries.${name}`),
    url: text(registry, 'url', HTTPS_ORIGIN_PATTERN, `registries.${name}`),
  };
}

function parseBudget(root: UnknownRecord): ReleaseContract['vsixBudget'] {
  const budget = section(root, 'vsixBudget', ['baselineCompressedBytes', 'baselinePackagedFileCount', 'compressedHeadroomPercent', 'maxEntryBytes', 'maxUncompressedBytes', 'packagedFileCountHeadroom']);
  return {
    baselineCompressedBytes: integer(budget, 'baselineCompressedBytes', 1, 'vsixBudget'),
    baselinePackagedFileCount: integer(budget, 'baselinePackagedFileCount', 1, 'vsixBudget'),
    compressedHeadroomPercent: integer(budget, 'compressedHeadroomPercent', 0, 'vsixBudget'),
    maxEntryBytes: integer(budget, 'maxEntryBytes', 1, 'vsixBudget'),
    maxUncompressedBytes: integer(budget, 'maxUncompressedBytes', 1, 'vsixBudget'),
    packagedFileCountHeadroom: integer(budget, 'packagedFileCountHeadroom', 0, 'vsixBudget'),
  };
}

export function parseReleaseContract(source: string): ReleaseContract {
  let value: unknown;
  try {
    value = JSON.parse(source);
  }
  catch (error) {
    throw contractError(`invalid JSON: ${describeError(error)}`);
  }
  const root = exactRecord(value, ['artifactPrefixes', 'bundle', 'candidateKeys', 'registries', 'schemaVersions', 'secrets', 'vsixBudget', 'workflows'], 'contract');
  const prefixes = section(root, 'artifactPrefixes', ['releaseCandidate', 'verifyEvidence']);
  const versions = section(root, 'schemaVersions', ['candidate', 'evidence', 'provenance']);
  const secrets = section(root, 'secrets', ['marketplace', 'openVsx', 'rejectedAliases']);
  const workflows = section(root, 'workflows', ['releaseCandidateName', 'signerPath', 'verifyName']);
  return {
    artifactPrefixes: {
      releaseCandidate: text(prefixes, 'releaseCandidate', PREFIX_PATTERN, 'artifactPrefixes'),
      verifyEvidence: text(prefixes, 'verifyEvidence', PREFIX_PATTERN, 'artifactPrefixes'),
    },
    bundle: parseBundle(root),
    candidateKeys: list(root, 'candidateKeys', entry => KEY_PATTERN.test(entry), 'root'),
    registries: { marketplace: parseRegistry(root, 'marketplace'), openVsx: parseRegistry(root, 'openVsx') },
    schemaVersions: {
      candidate: integer(versions, 'candidate', 1, 'schemaVersions'),
      evidence: integer(versions, 'evidence', 1, 'schemaVersions'),
      provenance: integer(versions, 'provenance', 1, 'schemaVersions'),
    },
    secrets: {
      marketplace: text(secrets, 'marketplace', SECRET_NAME_PATTERN, 'secrets'),
      openVsx: text(secrets, 'openVsx', SECRET_NAME_PATTERN, 'secrets'),
      rejectedAliases: list(secrets, 'rejectedAliases', entry => SECRET_NAME_PATTERN.test(entry), 'secrets'),
    },
    vsixBudget: parseBudget(root),
    workflows: {
      releaseCandidateName: text(workflows, 'releaseCandidateName', /^\S.*\S$|^\S$/u, 'workflows'),
      signerPath: text(workflows, 'signerPath', WORKFLOW_PATH_PATTERN, 'workflows'),
      verifyName: text(workflows, 'verifyName', /^\S.*\S$|^\S$/u, 'workflows'),
    },
  };
}

export function loadReleaseContract(rootDirectory: string = REPOSITORY_ROOT): ReleaseContract {
  return parseReleaseContract(readFileSync(resolve(rootDirectory, RELEASE_CONTRACT_PATH), 'utf8'));
}

export const RELEASE_CONTRACT = loadReleaseContract();
export const EVIDENCE_FILE = RELEASE_CONTRACT.bundle.evidence;
export const CANDIDATE_FILE = RELEASE_CONTRACT.bundle.candidate;

const { vsixBudget } = RELEASE_CONTRACT;
/** Measured clean-package baseline plus headroom; the post-publish comparison applies the same limits. */
export const CLEAN_BASELINE_COMPRESSED_BYTES = vsixBudget.baselineCompressedBytes;
export const CLEAN_BASELINE_PACKAGED_FILE_COUNT = vsixBudget.baselinePackagedFileCount;
export const COMPRESSED_SIZE_BUDGET_BYTES = Math.floor(CLEAN_BASELINE_COMPRESSED_BYTES * (100 + vsixBudget.compressedHeadroomPercent) / 100);
export const PACKAGED_FILE_COUNT_BUDGET = CLEAN_BASELINE_PACKAGED_FILE_COUNT + vsixBudget.packagedFileCountHeadroom;

export const VSIX_FILE_PATTERN = new RegExp(`^[A-Za-z0-9._-]+${RELEASE_CONTRACT.bundle.vsixExtension.replaceAll('.', '\\.')}$`, 'u');

/** File name of one bundle member; `vsixFile` supplies the stem of the VSIX-derived members. */
export function bundleFileName(role: BundleRole, vsixFile: string): string {
  const { bundle } = RELEASE_CONTRACT;
  const names: Record<BundleRole, string> = {
    candidate: bundle.candidate,
    digest: `${vsixFile}${bundle.digestSuffix}`,
    evidence: bundle.evidence,
    manifest: `${vsixFile}${bundle.manifestSuffix}`,
    provenance: bundle.provenance,
    sbom: bundle.sbom,
    vsix: vsixFile,
  };
  return names[role];
}

export function bundleMemberNames(kind: BundleKind, vsixFile: string): string[] {
  const members = kind === 'verify' ? RELEASE_CONTRACT.bundle.verifyMembers : RELEASE_CONTRACT.bundle.candidateMembers;
  return members.map(role => bundleFileName(role, vsixFile));
}

/** Newline-terminated glob list for an upload step, one pattern per bundle member. */
export function bundleUploadPaths(kind: BundleKind, directory: string): string {
  return bundleMemberNames(kind, `*${RELEASE_CONTRACT.bundle.vsixExtension}`).map(name => `${directory}/${name}\n`).join('');
}

export function candidateKey(name: string): string {
  if (!RELEASE_CONTRACT.candidateKeys.includes(name)) {
    throw contractError(`${name} is not a candidate key`);
  }
  return name;
}

export function registryDownloadUrl(name: RegistryName, values: { readonly name: string; readonly publisher: string; readonly version: string }): string {
  const { downloadPath, url } = RELEASE_CONTRACT.registries[name];
  return `${url}${downloadPath.replaceAll('{publisher}', values.publisher).replaceAll('{name}', values.name).replaceAll('{version}', values.version)}`;
}