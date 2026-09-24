import { describe, expect, it } from 'vitest';
import {
  buildArtifactProvenance,
  buildArtifactSbom,
  buildNormalizedManifest,
  findArtifactProvenanceViolation,
  findArtifactSbomViolation,
  findNormalizedManifestViolation,
  isWellFormedArtifactProvenance,
  isWellFormedArtifactSbom,
  parseNormalizedManifest,
  parsePackagedIdentity,
  readRuntimeDependencies,
  selectDeliveredRuntimeFiles,
} from '../tools';
import { cleanVsixArchiveEntries } from './fixtures/vsixFixtures';

const SOURCE_SHA = 'a'.repeat(40);
const ARTIFACT_SHA = 'b'.repeat(64);
const MANIFEST_SHA = 'c'.repeat(64);
const SBOM_SHA = 'd'.repeat(64);
const identity = { name: 'nestro', version: '0.5.0', publisher: 'greentech-solutions' } as const;
const runtimeFiles = selectDeliveredRuntimeFiles(cleanVsixArchiveEntries());
const dependencies = { 'npm-check-updates': '23.0.0' } as const;

function sbom() {
  return buildArtifactSbom({
    identity,
    artifactFile: 'nestro-0.5.0.vsix',
    artifactSha256: ARTIFACT_SHA,
    runtimeFiles,
    dependencies,
  });
}

function provenanceInput() {
  return {
    sourceSha: SOURCE_SHA,
    ciRunId: '42',
    ciRunAttempt: '2',
    eventName: 'push',
    repository: 'acme/nestro',
    signerWorkflow: 'acme/nestro/.github/workflows/ci.yml',
    artifactFile: 'nestro-0.5.0.vsix',
    artifactSha256: ARTIFACT_SHA,
    manifestFile: 'nestro-0.5.0.vsix.manifest.txt',
    manifestSha256: MANIFEST_SHA,
    sbomFile: 'sbom.json',
    sbomSha256: SBOM_SHA,
  } as const;
}

function provenance() {
  return buildArtifactProvenance(provenanceInput());
}

describe('artifact provenance contract', () => {
  it('builds a deterministic CycloneDX document bound to delivered runtime files', () => {
    const first = sbom();
    const second = sbom();

    expect(first).toEqual(second);
    expect(first.bomFormat).toBe('CycloneDX');
    expect(first.specVersion).toBe('1.5');
    expect(first.components).toEqual([expect.objectContaining({
      name: 'npm-check-updates',
      version: '23.0.0',
      delivery: 'bundled',
    })]);
    expect(first.properties).toEqual(expect.arrayContaining(runtimeFiles.map(file => expect.objectContaining({
      name: `nestro:runtime-file:${file.path}`,
    }))));
    expect(findArtifactSbomViolation(first, {
      identity,
      artifactFile: 'nestro-0.5.0.vsix',
      artifactSha256: ARTIFACT_SHA,
      runtimeFiles,
      dependencies,
    })).toBeUndefined();
  });

  it('rejects missing dependency and delivered-file evidence', () => {
    const valid = sbom();
    expect(findArtifactSbomViolation({ ...valid, components: [] }, {
      identity,
      artifactFile: 'nestro-0.5.0.vsix',
      artifactSha256: ARTIFACT_SHA,
      runtimeFiles,
      dependencies,
    })).toContain('incomplete');
    expect(findArtifactSbomViolation(valid, {
      identity,
      artifactFile: 'nestro-0.5.0.vsix',
      artifactSha256: ARTIFACT_SHA,
      runtimeFiles: runtimeFiles.slice(0, -1),
      dependencies,
    })).toContain('runtime file count');
  });

  it('validates every SBOM input and document boundary', () => {
    const expectation = {
      identity,
      artifactFile: 'nestro-0.5.0.vsix',
      artifactSha256: ARTIFACT_SHA,
      runtimeFiles,
      dependencies,
    } as const;
    const valid = sbom();

    expect(isWellFormedArtifactSbom(valid, expectation)).toBe(true);
    expect(isWellFormedArtifactSbom({ ...valid, serialNumber: 'bad' }, expectation)).toBe(false);
    expect(findArtifactSbomViolation(null, expectation)).toBe('SBOM must be an object');
    expect(findArtifactSbomViolation({ ...valid, extra: true }, expectation)).toContain('unexpected');
    expect(findArtifactSbomViolation({ ...valid, version: 2 }, expectation)).toContain('CycloneDX');
    expect(findArtifactSbomViolation({ ...valid, serialNumber: 'not-a-uuid' }, expectation)).toContain('UUID');
    expect(findArtifactSbomViolation({
      ...valid,
      metadata: { ...valid.metadata, component: { ...valid.metadata.component, publisher: 'other' } },
    }, expectation)).toContain('metadata identity');
    expect(findArtifactSbomViolation({ ...valid, properties: null }, expectation)).toContain('name/value');
    expect(findArtifactSbomViolation({
      ...valid,
      properties: valid.properties.map((property, index) => index === 3
        ? { ...property, value: 'forged' }
        : property),
    }, expectation)).toContain('delivered runtime file');
    expect(findArtifactSbomViolation({ ...valid, components: [null] }, expectation)).toContain('array of objects');
    expect(findArtifactSbomViolation({ ...valid, dependencies: null }, expectation)).toContain('array of objects');
    expect(findArtifactSbomViolation({
      ...valid,
      dependencies: valid.dependencies.map((dependency, index) => index === 0
        ? { ...dependency, dependsOn: [] }
        : dependency),
    }, expectation)).toContain('dependency graph');
    expect(findArtifactSbomViolation({
      ...valid,
      serialNumber: `urn:uuid:${'0'.repeat(36)}`,
    }, expectation)).toContain('deterministic');

    expect(() => buildArtifactSbom({ ...expectation, identity: { ...identity, name: '' } })).toThrow('identity');
    expect(() => buildArtifactSbom({ ...expectation, artifactFile: '../nestro.vsix' })).toThrow('safe filename');
    expect(() => buildArtifactSbom({ ...expectation, artifactFile: 'nestro.' })).toThrow('safe filename');
    expect(() => buildArtifactSbom({ ...expectation, artifactSha256: 'B'.repeat(64) })).toThrow('SHA-256');
    expect(() => buildArtifactSbom({ ...expectation, runtimeFiles: [] })).toThrow('at least one');
    expect(() => buildArtifactSbom({ ...expectation, dependencies: { broken: '' } })).toThrow('version spec');
    expect(() => buildArtifactSbom({
      ...expectation,
      runtimeFiles: [{ path: 'extension/readme.md', bytes: new Uint8Array([1]) }],
    })).toThrow('delivered runtime file');
    expect(() => buildArtifactSbom({
      ...expectation,
      runtimeFiles: [runtimeFiles[0], runtimeFiles[0]],
    })).toThrow('duplicate file');
    expect(buildArtifactSbom({
      ...expectation,
      dependencies: {},
      optionalDependencies: { '@scope/tool': '^1.2.3' },
    }).components).toEqual([expect.objectContaining({ scope: 'optional', name: '@scope/tool' })]);
  });

  it('binds provenance to source, workflow and exact subject digest', () => {
    const valid = provenance();
    expect(findArtifactProvenanceViolation(valid, {
      sourceSha: SOURCE_SHA,
      ciRunId: '42',
      ciRunAttempt: '2',
      eventName: 'push',
      repository: 'acme/nestro',
      signerWorkflow: 'acme/nestro/.github/workflows/ci.yml',
      artifactFile: 'nestro-0.5.0.vsix',
      artifactSha256: ARTIFACT_SHA,
      manifestFile: 'nestro-0.5.0.vsix.manifest.txt',
      manifestSha256: MANIFEST_SHA,
      sbomFile: 'sbom.json',
      sbomSha256: SBOM_SHA,
    })).toBeUndefined();
    expect(findArtifactProvenanceViolation({
      ...valid,
      attestation: { ...valid.attestation, subjectDigest: `sha256:${'e'.repeat(64)}` },
    })).toContain('subject or digest');
    expect(findArtifactProvenanceViolation(valid, {
      ...valid,
      sourceSha: 'f'.repeat(40),
      artifactFile: valid.artifact.file,
      artifactSha256: valid.artifact.sha256,
      manifestFile: valid.artifact.manifestFile,
      manifestSha256: valid.artifact.manifestSha256,
      sbomFile: valid.artifact.sbomFile,
      sbomSha256: valid.artifact.sbomSha256,
    })).toContain('exact candidate identity');
  });

  it('fails closed for malformed provenance and packaged metadata', () => {
    const valid = provenance();
    expect(isWellFormedArtifactProvenance(valid)).toBe(true);
    expect(isWellFormedArtifactProvenance({ ...valid, sourceSha: 'bad' })).toBe(false);
    expect(findArtifactProvenanceViolation(null)).toBe('provenance must be an object');
    expect(findArtifactProvenanceViolation({ ...valid, extra: true })).toContain('unexpected');
    expect(findArtifactProvenanceViolation({ ...valid, eventName: 'invalid' })).toContain('malformed');
    expect(findArtifactProvenanceViolation({ ...valid, artifact: null })).toContain('linkage');
    expect(findArtifactProvenanceViolation({ ...valid, attestation: null })).toContain('subject or digest');

    expect(() => buildArtifactProvenance({ ...provenanceInput(), sourceSha: 'bad' })).toThrow('sourceSha');
    expect(() => buildArtifactProvenance({ ...provenanceInput(), ciRunId: '0' })).toThrow('CI run identity');
    expect(() => buildArtifactProvenance({ ...provenanceInput(), repository: 'acme' })).toThrow('owner/name');
    expect(() => buildArtifactProvenance({ ...provenanceInput(), signerWorkflow: 'acme/nestro/ci.yml' })).toThrow('repository workflow');
    expect(() => buildArtifactProvenance({ ...provenanceInput(), artifactFile: '../artifact.vsix' })).toThrow('safe filename');
    expect(() => buildArtifactProvenance({ ...provenanceInput(), manifestFile: 'manifest.' })).toThrow('safe filename');
    expect(() => buildArtifactProvenance({ ...provenanceInput(), sbomFile: 'sbom/' })).toThrow('safe filename');
    expect(() => buildArtifactProvenance({ ...provenanceInput(), artifactSha256: 'bad' })).toThrow('SHA-256');
    expect(() => buildArtifactProvenance({ ...provenanceInput(), manifestSha256: 'bad' })).toThrow('SHA-256');
    expect(() => buildArtifactProvenance({ ...provenanceInput(), sbomSha256: 'bad' })).toThrow('SHA-256');

    expect(() => parsePackagedIdentity(new TextEncoder().encode('{'))).toThrow('not valid JSON');
    expect(() => parsePackagedIdentity(new TextEncoder().encode('null'))).toThrow('non-empty');
    expect(parsePackagedIdentity(new TextEncoder().encode('{"name":"nestro","version":"1.0.0","publisher":"acme"}')))
      .toEqual({ name: 'nestro', version: '1.0.0', publisher: 'acme' });
    expect(() => readRuntimeDependencies(null)).toThrow('must be an object');
    expect(readRuntimeDependencies({})).toEqual({ dependencies: {}, optionalDependencies: {} });
    expect(readRuntimeDependencies({ dependencies: { dep: '^1.0.0' }, optionalDependencies: { opt: '^2.0.0' } }))
      .toEqual({ dependencies: { dep: '^1.0.0' }, optionalDependencies: { opt: '^2.0.0' } });
    expect(() => readRuntimeDependencies({ dependencies: [] })).toThrow('must be an object');
    expect(() => readRuntimeDependencies({ dependencies: { dep: '' } })).toThrow('version spec');
  });

  it('round-trips a normalized manifest and rejects unsafe or substituted input', () => {
    const entries = cleanVsixArchiveEntries();
    const manifest = buildNormalizedManifest(entries);
    expect(parseNormalizedManifest(manifest)).toHaveLength(entries.length);
    expect(findNormalizedManifestViolation(manifest, entries)).toBeUndefined();
    expect(findNormalizedManifestViolation(manifest, entries.slice(1))).toContain('does not match');
    expect(() => parseNormalizedManifest(`${ARTIFACT_SHA}  ../escape\n`)).toThrow('unsafe entry');
    expect(() => parseNormalizedManifest(manifest.slice(0, -1))).toThrow('end with one newline');
    expect(() => parseNormalizedManifest(`${ARTIFACT_SHA}  extension/a\r\n`)).toThrow('LF lines');
    expect(() => parseNormalizedManifest('\n')).toThrow('non-empty entry');
    expect(() => parseNormalizedManifest(`${ARTIFACT_SHA}  /absolute\n`)).toThrow('unsafe entry');
    expect(() => parseNormalizedManifest(`${ARTIFACT_SHA}  extension/b\n${ARTIFACT_SHA}  extension/a\n`)).toThrow('sorted');
    expect(() => parseNormalizedManifest(`${ARTIFACT_SHA}  extension/a\n${ARTIFACT_SHA}  extension/a\n`)).toThrow('duplicate');
    expect(findNormalizedManifestViolation('not a manifest', entries)).toContain('normalized manifest');
  });
});