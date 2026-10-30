import { assertSafeFileName, assertSha256 } from './artifactFields';
import type { ExtensionIdentity } from './extensionIdentity';
import { RUNTIME_FILE_PATTERN } from './packagedRuntime';
import type { ArtifactRuntimeFile } from './packagedRuntime';
import { compareCodeUnits, hasExactKeys, isRecord, sha256Hex } from '../shared';

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
    readonly component: ExtensionIdentity & { readonly type: 'application' };
  };
  readonly properties: readonly ArtifactSbomProperty[];
  readonly serialNumber: string;
  readonly specVersion: '1.5';
  readonly version: 1;
}

/** Everything the SBOM of one packaged artifact is derived from; building and verifying take the same input. */
export interface ArtifactSbomInput {
  readonly identity: ExtensionIdentity;
  readonly artifactFile: string;
  readonly artifactSha256: string;
  readonly runtimeFiles: readonly ArtifactRuntimeFile[];
  readonly dependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

function serialFor(document: Omit<ArtifactSbom, 'serialNumber'>): string {
  const digest = sha256Hex(new TextEncoder().encode(JSON.stringify(document)));
  return `urn:uuid:${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function assertIdentity(identity: ExtensionIdentity, label: string): void {
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
  const names = [...new Set([...Object.keys(dependencies), ...Object.keys(optional)])].sort(compareCodeUnits);
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
    .sort((left, right) => compareCodeUnits(left.path, right.path))
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

function buildComponents(input: ArtifactSbomInput): ArtifactSbomComponent[] {
  return dependencyEntries(input.dependencies, input.optionalDependencies).map(({ name, version, scope }) => ({
    'bom-ref': dependencyRef(name, version),
    delivery: 'bundled',
    name,
    purl: dependencyRef(name, version),
    scope,
    version,
  }));
}

function buildDependencyGraph(identity: ExtensionIdentity, components: readonly ArtifactSbomComponent[]): ArtifactSbomDependency[] {
  return [
    { ref: dependencyRef(identity.name, identity.version), dependsOn: components.map(component => component['bom-ref']) },
    ...components.map(component => ({ ref: component['bom-ref'], dependsOn: [] })),
  ];
}

export function buildArtifactSbom(input: ArtifactSbomInput): ArtifactSbom {
  assertIdentity(input.identity, 'SBOM identity');
  assertSafeFileName(input.artifactFile, 'SBOM artifact file');
  assertSha256(input.artifactSha256, 'SBOM artifact digest');
  if (input.runtimeFiles.length === 0) {
    throw new Error('SBOM must include at least one delivered runtime file');
  }
  const components = buildComponents(input);
  const documentWithoutSerial = {
    bomFormat: 'CycloneDX' as const,
    components,
    dependencies: buildDependencyGraph(input.identity, components),
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

function findProperty(properties: readonly ArtifactSbomProperty[], name: string): ArtifactSbomProperty | undefined {
  return properties.find(property => property.name === name);
}

function findHeaderViolation(value: unknown, expectation: ArtifactSbomInput): string | undefined {
  if (!isRecord(value)) {
    return 'SBOM must be an object';
  }
  if (!hasExactKeys(value, ['bomFormat', 'components', 'dependencies', 'metadata', 'properties', 'serialNumber', 'specVersion', 'version'])) {
    return 'SBOM contains unexpected or missing fields';
  }
  if (value.bomFormat !== 'CycloneDX' || value.specVersion !== '1.5' || value.version !== 1) {
    return 'SBOM must use CycloneDX schema version 1.5';
  }
  if (typeof value.serialNumber !== 'string' || !/^urn:uuid:[0-9a-f-]{36}$/u.test(value.serialNumber)) {
    return 'SBOM serialNumber must be a UUID URN';
  }
  const metadata = value.metadata;
  if (!isRecord(metadata) || !hasExactKeys(metadata, ['component']) || !isRecord(metadata.component)
    || !hasExactKeys(metadata.component, ['name', 'publisher', 'type', 'version'])
    || metadata.component.type !== 'application'
    || metadata.component.name !== expectation.identity.name
    || metadata.component.version !== expectation.identity.version
    || metadata.component.publisher !== expectation.identity.publisher) {
    return 'SBOM metadata identity does not match the packaged extension';
  }
  return undefined;
}

function findPropertiesViolation(properties: unknown, expectation: ArtifactSbomInput): string | undefined {
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
  for (const property of runtimeFileProperties(expectation.runtimeFiles)) {
    if (findProperty(typedProperties, property.name)?.value !== property.value) {
      return `SBOM is missing the delivered runtime file ${property.name.slice('nestro:runtime-file:'.length)}`;
    }
  }
  return undefined;
}

function findGraphViolation(components: unknown, dependencies: unknown, expectation: ArtifactSbomInput): string | undefined {
  if (!Array.isArray(components) || !components.every(isRecord)) {
    return 'SBOM components must be an array of objects';
  }
  const expectedComponents = buildComponents(expectation);
  if (JSON.stringify(components) !== JSON.stringify(expectedComponents)) {
    return 'SBOM runtime dependency components are incomplete or reordered';
  }
  if (!Array.isArray(dependencies) || !dependencies.every(isRecord)) {
    return 'SBOM dependencies must be an array of objects';
  }
  if (JSON.stringify(dependencies) !== JSON.stringify(buildDependencyGraph(expectation.identity, expectedComponents))) {
    return 'SBOM dependency graph is incomplete or does not match the delivered runtime dependencies';
  }
  return undefined;
}

/** Returns why `value` is not the SBOM that `expectation` builds, or `undefined` when it is exactly that SBOM. */
export function findArtifactSbomViolation(value: unknown, expectation: ArtifactSbomInput): string | undefined {
  const headerViolation = findHeaderViolation(value, expectation);
  if (headerViolation !== undefined) {
    return headerViolation;
  }
  const document = value as Record<string, unknown>;
  const violation = findPropertiesViolation(document.properties, expectation)
    ?? findGraphViolation(document.components, document.dependencies, expectation);
  if (violation !== undefined) {
    return violation;
  }
  return document.serialNumber === buildArtifactSbom(expectation).serialNumber
    ? undefined
    : 'SBOM serialNumber is not deterministic for the candidate contents';
}