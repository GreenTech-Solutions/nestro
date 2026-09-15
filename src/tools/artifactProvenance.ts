import { createHash } from 'node:crypto';

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const RUN_ID_PATTERN = /^[1-9]\d*$/u;
const SAFE_FILE_PATTERN = /^[A-Za-z0-9._-]+$/u;
const SAFE_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SAFE_WORKFLOW_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/u;
const MANIFEST_LINE_PATTERN = /^([0-9a-f]{64}) {2}([^\r\n]+)$/u;
const RUNTIME_FILE_PATTERN = /^extension\/(?:package\.json|out\/[A-Za-z0-9._$@-]+\.cjs)$/u;

export const ARTIFACT_SBOM_FILE = 'sbom.json';
export const ARTIFACT_PROVENANCE_FILE = 'provenance.json';
export const ARTIFACT_PROVENANCE_SCHEMA_VERSION = 1 as const;
export const RELEASE_CANDIDATE_SCHEMA_VERSION = 2 as const;

export interface ArtifactPackageIdentity {
  readonly name: string;
  readonly version: string;
  readonly publisher: string;
}

export interface ArtifactRuntimeFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface ArtifactSbomComponent {
  readonly 'bom-ref': string;
  readonly delivery: 'bundled' | 'provided';
  readonly name: string;
  readonly purl: string;
  readonly scope: 'optional' | 'required';
  readonly version: string;
}

export interface ArtifactSbomDependency {
  readonly ref: string;
  readonly dependsOn: readonly string[];
}

export interface ArtifactSbomProperty {
  readonly name: string;
  readonly value: string;
}

export interface ArtifactSbom {
  readonly bomFormat: 'CycloneDX';
  readonly components: readonly ArtifactSbomComponent[];
  readonly dependencies: readonly ArtifactSbomDependency[];
  readonly metadata: {
    readonly component: ArtifactPackageIdentity & { readonly type: 'application' };
  };
  readonly properties: readonly ArtifactSbomProperty[];
  readonly serialNumber: string;
  readonly specVersion: '1.5';
  readonly version: 1;
}

export interface ArtifactSbomInput {
  readonly identity: ArtifactPackageIdentity;
  readonly artifactFile: string;
  readonly artifactSha256: string;
  readonly runtimeFiles: readonly ArtifactRuntimeFile[];
  readonly dependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

export interface ArtifactSbomExpectation {
  readonly identity: ArtifactPackageIdentity;
  readonly artifactFile: string;
  readonly artifactSha256: string;
  readonly runtimeFiles: readonly ArtifactRuntimeFile[];
  readonly dependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

export interface ArtifactProvenance {
  readonly schemaVersion: typeof ARTIFACT_PROVENANCE_SCHEMA_VERSION;
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

export interface ArtifactProvenanceExpectation extends ArtifactProvenanceInput {}

export interface NormalizedManifestEntry {
  readonly path: string;
  readonly sha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(sortedStrings(Object.keys(value))) === JSON.stringify(sortedStrings(expected));
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function serialFor(document: Omit<ArtifactSbom, 'serialNumber'>): string {
  const digest = sha256Hex(new TextEncoder().encode(stableJson(document)));
  return `urn:uuid:${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function assertSafeFileName(file: string, label: string): void {
  if (!SAFE_FILE_PATTERN.test(file) || file.endsWith('.')) {
    throw new Error(`${label} must be a safe filename`);
  }
}

function assertSha256(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase 64-character SHA-256 digest`);
  }
}

function assertIdentity(identity: ArtifactPackageIdentity, label: string): void {
  if (!isRecord(identity)
    || typeof identity.name !== 'string'
    || typeof identity.version !== 'string'
    || typeof identity.publisher !== 'string'
    || identity.name.length === 0
    || identity.version.length === 0
    || identity.publisher.length === 0) {
    throw new Error(`${label} must contain non-empty name, version, and publisher strings`);
  }
}

function dependencyEntries(
  dependencies: Readonly<Record<string, string>>,
  optionalDependencies: Readonly<Record<string, string>> | undefined,
): { name: string; version: string; scope: 'optional' | 'required' }[] {
  const optional = optionalDependencies ?? {};
  const names = sortedStrings([...new Set([...Object.keys(dependencies), ...Object.keys(optional)])]);
  return names.map((name) => {
    const version = optional[name] ?? dependencies[name];
    if (typeof version !== 'string' || version.length === 0) {
      throw new Error(`runtime dependency ${name} must have a non-empty version spec`);
    }
    return { name, version, scope: optional[name] === undefined ? 'required' : 'optional' };
  });
}

function dependencyRef(name: string, version: string): string {
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function runtimeFileProperties(runtimeFiles: readonly ArtifactRuntimeFile[]): ArtifactSbomProperty[] {
  const seen = new Set<string>();
  return [...runtimeFiles]
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map((file) => {
      if (!RUNTIME_FILE_PATTERN.test(file.path)) {
        throw new Error(`runtime SBOM file path ${file.path} is not a delivered runtime file`);
      }
      if (seen.has(file.path)) {
        throw new Error(`runtime SBOM contains duplicate file ${file.path}`);
      }
      seen.add(file.path);
      return {
        name: `nestro:runtime-file:${file.path}`,
        value: `${sha256Hex(file.bytes)}:${file.bytes.length}`,
      };
    });
}

export function buildArtifactSbom(input: ArtifactSbomInput): ArtifactSbom {
  assertIdentity(input.identity, 'SBOM identity');
  assertSafeFileName(input.artifactFile, 'SBOM artifact file');
  assertSha256(input.artifactSha256, 'SBOM artifact digest');
  if (input.runtimeFiles.length === 0) {
    throw new Error('SBOM must include at least one delivered runtime file');
  }
  const dependencies = dependencyEntries(input.dependencies, input.optionalDependencies);
  const components = dependencies.map(({ name, version, scope }) => ({
    'bom-ref': dependencyRef(name, version),
    delivery: 'bundled' as const,
    name,
    purl: dependencyRef(name, version),
    scope,
    version,
  }));
  const rootRef = dependencyRef(input.identity.name, input.identity.version);
  const documentWithoutSerial = {
    bomFormat: 'CycloneDX' as const,
    components,
    dependencies: [{
      ref: rootRef,
      dependsOn: components.map(component => component['bom-ref']),
    }, ...components.map(component => ({ ref: component['bom-ref'], dependsOn: [] as string[] }))],
    metadata: {
      component: {
        type: 'application' as const,
        ...input.identity,
      },
    },
    properties: [
      { name: 'nestro:artifact-file', value: input.artifactFile },
      { name: 'nestro:artifact-sha256', value: input.artifactSha256 },
      { name: 'nestro:runtime-file-count', value: String(input.runtimeFiles.length) },
      ...runtimeFileProperties(input.runtimeFiles),
    ],
    specVersion: '1.5' as const,
    version: 1 as const,
  };
  return { ...documentWithoutSerial, serialNumber: serialFor(documentWithoutSerial) };
}

function expectedComponentValues(expectation: ArtifactSbomExpectation): ArtifactSbomComponent[] {
  return dependencyEntries(expectation.dependencies, expectation.optionalDependencies).map(({ name, version, scope }) => ({
    'bom-ref': dependencyRef(name, version),
    delivery: 'bundled',
    name,
    purl: dependencyRef(name, version),
    scope,
    version,
  }));
}

function findProperty(properties: readonly ArtifactSbomProperty[], name: string): ArtifactSbomProperty | undefined {
  return properties.find(property => property.name === name);
}

export function findArtifactSbomViolation(value: unknown, expectation: ArtifactSbomExpectation): string | undefined {
  if (!isRecord(value)) {
    return 'SBOM must be an object';
  }
  if (!exactKeys(value, ['bomFormat', 'components', 'dependencies', 'metadata', 'properties', 'serialNumber', 'specVersion', 'version'])) {
    return 'SBOM contains unexpected or missing fields';
  }
  if (value.bomFormat !== 'CycloneDX' || value.specVersion !== '1.5' || value.version !== 1) {
    return 'SBOM must use CycloneDX schema version 1.5';
  }
  if (typeof value.serialNumber !== 'string' || !/^urn:uuid:[0-9a-f-]{36}$/u.test(value.serialNumber)) {
    return 'SBOM serialNumber must be a UUID URN';
  }
  const metadata = value.metadata;
  if (!isRecord(metadata) || !exactKeys(metadata, ['component']) || !isRecord(metadata.component)
    || !exactKeys(metadata.component, ['name', 'publisher', 'type', 'version'])
    || metadata.component.type !== 'application'
    || metadata.component.name !== expectation.identity.name
    || metadata.component.version !== expectation.identity.version
    || metadata.component.publisher !== expectation.identity.publisher) {
    return 'SBOM metadata identity does not match the packaged extension';
  }
  const properties = value.properties;
  if (!Array.isArray(properties) || !properties.every(isRecord)
    || !properties.every(property => typeof property.name === 'string' && typeof property.value === 'string')) {
    return 'SBOM properties must be name/value strings';
  }
  const typedProperties = properties as unknown as ArtifactSbomProperty[];
  if (typedProperties.length !== 3 + expectation.runtimeFiles.length
    || findProperty(typedProperties, 'nestro:artifact-file')?.value !== expectation.artifactFile
    || findProperty(typedProperties, 'nestro:artifact-sha256')?.value !== expectation.artifactSha256
    || findProperty(typedProperties, 'nestro:runtime-file-count')?.value !== String(expectation.runtimeFiles.length)) {
    return 'SBOM artifact identity or runtime file count does not match the candidate';
  }
  const expectedRuntimeProperties = runtimeFileProperties(expectation.runtimeFiles);
  for (const property of expectedRuntimeProperties) {
    const actual = findProperty(typedProperties, property.name);
    if (actual?.value !== property.value) {
      return `SBOM is missing the delivered runtime file ${property.name.slice('nestro:runtime-file:'.length)}`;
    }
  }
  const components = value.components;
  if (!Array.isArray(components) || !components.every(isRecord)) {
    return 'SBOM components must be an array of objects';
  }
  const expectedComponents = expectedComponentValues(expectation);
  if (JSON.stringify(components) !== JSON.stringify(expectedComponents)) {
    return 'SBOM runtime dependency components are incomplete or reordered';
  }
  const dependencies = value.dependencies;
  if (!Array.isArray(dependencies) || !dependencies.every(isRecord)) {
    return 'SBOM dependencies must be an array of objects';
  }
  const expectedRootRef = dependencyRef(expectation.identity.name, expectation.identity.version);
  const expectedDependencyGraph = [
    { ref: expectedRootRef, dependsOn: expectedComponents.map(component => component['bom-ref']) },
    ...expectedComponents.map(component => ({ ref: component['bom-ref'], dependsOn: [] })),
  ];
  if (JSON.stringify(dependencies) !== JSON.stringify(expectedDependencyGraph)) {
    return 'SBOM dependency graph is incomplete or does not match the delivered runtime dependencies';
  }
  const expected = buildArtifactSbom({
    identity: expectation.identity,
    artifactFile: expectation.artifactFile,
    artifactSha256: expectation.artifactSha256,
    runtimeFiles: expectation.runtimeFiles,
    dependencies: expectation.dependencies,
    optionalDependencies: expectation.optionalDependencies,
  });
  if (value.serialNumber !== expected.serialNumber) {
    return 'SBOM serialNumber is not deterministic for the candidate contents';
  }
  return undefined;
}

export function isWellFormedArtifactSbom(value: unknown, expectation: ArtifactSbomExpectation): value is ArtifactSbom {
  return findArtifactSbomViolation(value, expectation) === undefined;
}

export function buildArtifactProvenance(input: ArtifactProvenanceInput): ArtifactProvenance {
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
  const provenance: ArtifactProvenance = {
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
  const violation = findArtifactProvenanceViolation(provenance, input);
  if (violation !== undefined) {
    throw new Error(violation);
  }
  return provenance;
}

export function findArtifactProvenanceViolation(value: unknown, expectation?: ArtifactProvenanceExpectation): string | undefined {
  if (!isRecord(value)) {
    return 'provenance must be an object';
  }
  if (!exactKeys(value, ['artifact', 'attestation', 'ciRunAttempt', 'ciRunId', 'eventName', 'repository', 'schemaVersion', 'signerWorkflow', 'sourceSha'])) {
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
  if (!isRecord(artifact) || !exactKeys(artifact, ['file', 'manifestFile', 'manifestSha256', 'sbomFile', 'sbomSha256', 'sha256'])
    || typeof artifact.file !== 'string' || typeof artifact.manifestFile !== 'string' || typeof artifact.sbomFile !== 'string'
    || typeof artifact.sha256 !== 'string' || typeof artifact.manifestSha256 !== 'string' || typeof artifact.sbomSha256 !== 'string'
    || !SAFE_FILE_PATTERN.test(artifact.file) || !SAFE_FILE_PATTERN.test(artifact.manifestFile) || !SAFE_FILE_PATTERN.test(artifact.sbomFile)
    || !SHA256_PATTERN.test(artifact.sha256) || !SHA256_PATTERN.test(artifact.manifestSha256) || !SHA256_PATTERN.test(artifact.sbomSha256)) {
    return 'provenance artifact linkage is malformed';
  }
  const attestation = value.attestation;
  if (!isRecord(attestation) || !exactKeys(attestation, ['signerWorkflow', 'subjectDigest', 'subjectName'])
    || attestation.subjectName !== artifact.file
    || attestation.subjectDigest !== `sha256:${artifact.sha256}`
    || attestation.signerWorkflow !== value.signerWorkflow) {
    return 'provenance attestation subject or digest does not match the artifact';
  }
  if (expectation !== undefined) {
    const expected = buildArtifactProvenanceWithoutValidation(expectation);
    if (JSON.stringify(value) !== JSON.stringify(expected)) {
      return 'provenance does not match the exact candidate identity';
    }
  }
  return undefined;
}

function buildArtifactProvenanceWithoutValidation(input: ArtifactProvenanceInput): ArtifactProvenance {
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

export function isWellFormedArtifactProvenance(value: unknown, expectation?: ArtifactProvenanceExpectation): value is ArtifactProvenance {
  return findArtifactProvenanceViolation(value, expectation) === undefined;
}

export function buildNormalizedManifest(entries: readonly { path: string; bytes: Uint8Array }[]): string {
  return [...entries]
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map(entry => `${sha256Hex(entry.bytes)}  ${entry.path}`)
    .join('\n') + '\n';
}

export function parseNormalizedManifest(contents: string): NormalizedManifestEntry[] {
  if (!contents.endsWith('\n') || contents.includes('\r')) {
    throw new Error('normalized manifest must use LF lines and end with one newline');
  }
  const lines = contents.slice(0, -1).split('\n');
  if (lines.length === 0 || lines.some(line => line.length === 0)) {
    throw new Error('normalized manifest must contain at least one non-empty entry');
  }
  const entries = lines.map((line) => {
    const match = MANIFEST_LINE_PATTERN.exec(line);
    if (match === null || match[2].length === 0 || match[2].startsWith('/') || match[2].includes('..')) {
      throw new Error(`normalized manifest contains an unsafe entry: ${line}`);
    }
    return { sha256: match[1], path: match[2] };
  });
  const sorted = [...entries].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (JSON.stringify(entries) !== JSON.stringify(sorted)) {
    throw new Error('normalized manifest entries must be sorted by archive path');
  }
  if (new Set(entries.map(entry => entry.path)).size !== entries.length) {
    throw new Error('normalized manifest must not contain duplicate paths');
  }
  return entries;
}

export function findNormalizedManifestViolation(
  contents: string,
  entries: readonly { path: string; bytes: Uint8Array }[],
): string | undefined {
  let parsed: NormalizedManifestEntry[];
  try {
    parsed = parseNormalizedManifest(contents);
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const expected = parseNormalizedManifest(buildNormalizedManifest(entries));
  return JSON.stringify(parsed) === JSON.stringify(expected)
    ? undefined
    : 'normalized manifest does not match the candidate archive contents';
}

export function selectDeliveredRuntimeFiles(entries: readonly { path: string; bytes: Uint8Array }[]): ArtifactRuntimeFile[] {
  return entries
    .filter(entry => RUNTIME_FILE_PATTERN.test(entry.path))
    .map(entry => ({ path: entry.path, bytes: entry.bytes }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export function parsePackagedIdentity(bytes: Uint8Array, label = 'extension/package.json'): ArtifactPackageIdentity {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  }
  catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.version !== 'string' || typeof value.publisher !== 'string'
    || value.name.length === 0 || value.version.length === 0 || value.publisher.length === 0) {
    throw new Error(`${label} must contain non-empty name, version, and publisher strings`);
  }
  return { name: value.name, version: value.version, publisher: value.publisher };
}

export function readRuntimeDependencies(manifest: unknown): {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
} {
  if (!isRecord(manifest)) {
    throw new Error('packaged package.json must be an object');
  }
  const read = (key: string): Record<string, string> => {
    const value = manifest[key];
    if (value === undefined) {
      return {};
    }
    if (!isRecord(value)) {
      throw new Error(`packaged package.json ${key} must be an object`);
    }
    const result: Record<string, string> = {};
    for (const [name, version] of Object.entries(value)) {
      if (typeof version !== 'string' || version.length === 0) {
        throw new Error(`packaged package.json ${key}.${name} must be a non-empty version spec`);
      }
      result[name] = version;
    }
    return result;
  };
  return { dependencies: read('dependencies'), optionalDependencies: read('optionalDependencies') };
}