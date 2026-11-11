import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildReleaseCandidate,
  bundleFileName,
  bundleMemberNames,
  bundleUploadPaths,
  candidateKey,
  COMPRESSED_SIZE_BUDGET_BYTES,
  loadReleaseContract,
  PACKAGED_FILE_COUNT_BUDGET,
  parseReleaseContract,
  registryDownloadUrl,
  RELEASE_CONTRACT,
  RELEASE_CONTRACT_PATH,
  VSIX_FILE_PATTERN,
} from '../tools';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const canonicalSource = readFileSync(resolve(repositoryRoot, RELEASE_CONTRACT_PATH), 'utf8');

interface ContractDraft {
  [key: string]: unknown;
  artifactPrefixes: Record<string, unknown>;
  bundle: Record<string, unknown>;
  candidateKeys: unknown;
  registries: Record<string, Record<string, unknown>>;
  schemaVersions: Record<string, unknown>;
  secrets: Record<string, unknown>;
  vsixBudget: Record<string, unknown>;
  workflows: Record<string, unknown>;
}

function contractWith(mutator: (draft: ContractDraft) => void): string {
  const draft = JSON.parse(canonicalSource) as ContractDraft;
  mutator(draft);
  return JSON.stringify(draft);
}

describe('release contract', () => {
  it('loads the canonical file from the repository root', () => {
    expect(loadReleaseContract(repositoryRoot)).toEqual(RELEASE_CONTRACT);
    expect(parseReleaseContract(canonicalSource)).toEqual(RELEASE_CONTRACT);
  });

  it('pins the reviewed contract values', () => {
    expect(RELEASE_CONTRACT.schemaVersions).toEqual({ candidate: 2, evidence: 1, provenance: 1 });
    expect(RELEASE_CONTRACT.workflows).toEqual({
      releaseCandidateName: 'Release candidate',
      signerPath: '.github/workflows/ci.yml',
      verifyName: 'Verify',
    });
    expect(RELEASE_CONTRACT.artifactPrefixes).toEqual({ releaseCandidate: 'release-candidate-', verifyEvidence: 'verify-evidence-' });
    expect(RELEASE_CONTRACT.secrets).toEqual({
      marketplace: 'VSCE_PAT',
      openVsx: 'OVSX_PAT',
      rejectedAliases: ['VSCE_TOKEN', 'OPEN_VSX_TOKEN'],
    });
    expect(COMPRESSED_SIZE_BUDGET_BYTES).toBe(1126757);
    expect(PACKAGED_FILE_COUNT_BUDGET).toBe(26);
    expect(RELEASE_CONTRACT.vsixBudget.maxEntryBytes).toBe(5242880);
    expect(RELEASE_CONTRACT.vsixBudget.maxUncompressedBytes).toBe(10485760);
  });

  it('derives the bundle member names for each bundle kind', () => {
    expect(bundleMemberNames('verify', 'nestro-1.0.0.vsix')).toEqual([
      'nestro-1.0.0.vsix',
      'nestro-1.0.0.vsix.manifest.txt',
      'nestro-1.0.0.vsix.sha256',
      'evidence.json',
      'sbom.json',
      'provenance.json',
    ]);
    expect(bundleMemberNames('candidate', 'nestro-1.0.0.vsix')).toEqual([
      'nestro-1.0.0.vsix',
      'nestro-1.0.0.vsix.manifest.txt',
      'nestro-1.0.0.vsix.sha256',
      'sbom.json',
      'provenance.json',
      'candidate.json',
    ]);
    expect(bundleFileName('digest', 'a.vsix')).toBe('a.vsix.sha256');
  });

  it('renders upload globs with one pattern per member and a trailing newline', () => {
    expect(bundleUploadPaths('candidate', 'dist/release-candidate')).toBe([
      'dist/release-candidate/*.vsix',
      'dist/release-candidate/*.vsix.manifest.txt',
      'dist/release-candidate/*.vsix.sha256',
      'dist/release-candidate/sbom.json',
      'dist/release-candidate/provenance.json',
      'dist/release-candidate/candidate.json',
      '',
    ].join('\n'));
  });

  it('accepts only safe VSIX file names', () => {
    expect(VSIX_FILE_PATTERN.test('nestro-1.0.0.vsix')).toBe(true);
    expect(VSIX_FILE_PATTERN.test('../nestro.vsix')).toBe(false);
    expect(VSIX_FILE_PATTERN.test('nestro.vsixx')).toBe(false);
    expect(VSIX_FILE_PATTERN.test('nestro-1.0.0.zip')).toBe(false);
  });

  it('keeps the candidate key list equal to the keys of a built manifest', () => {
    const outcome = buildReleaseCandidate({
      sourceSha: 'a'.repeat(40),
      runId: '42',
      runAttempt: '1',
      vsixFile: 'nestro-0.5.0.vsix',
      vsixSha256: 'b'.repeat(64),
      eventName: 'push',
      pullRequestHeadSha: null,
      releaseEligible: false,
    }, '0.5.0', [], 'notes', {
      candidateRunId: '77',
      artifact: {
        vsixFile: 'nestro-0.5.0.vsix',
        digestFile: 'nestro-0.5.0.vsix.sha256',
        digest: 'b'.repeat(64),
        manifestFile: 'nestro-0.5.0.vsix.manifest.txt',
        manifestSha256: 'c'.repeat(64),
        sbomFile: 'sbom.json',
        sbomSha256: 'd'.repeat(64),
        provenanceFile: 'provenance.json',
        provenanceSha256: 'e'.repeat(64),
      },
    });
    expect(outcome.isCandidate).toBe(true);
    if (outcome.isCandidate) {
      expect(Object.keys(outcome.manifest).sort((left, right) => left.localeCompare(right)))
        .toEqual([...RELEASE_CONTRACT.candidateKeys].sort((left, right) => left.localeCompare(right)));
    }
  });

  it('resolves candidate keys and rejects unknown ones', () => {
    expect(candidateKey('sbomSha256')).toBe('sbomSha256');
    expect(() => candidateKey('sbomSha512')).toThrow('not a candidate key');
  });

  it('expands registry download paths', () => {
    const values = { name: 'nestro', publisher: 'acme', version: '1.2.3' };
    expect(registryDownloadUrl('marketplace', values))
      .toBe('https://marketplace.visualstudio.com/_apis/public/gallery/publishers/acme/vsextensions/nestro/1.2.3/vspackage');
    expect(registryDownloadUrl('openVsx', values)).toBe('https://open-vsx.org/api/acme/nestro/1.2.3/file/acme.nestro-1.2.3.vsix');
  });

  it('reports a missing file with the contract path', () => {
    expect(() => loadReleaseContract(resolve(repositoryRoot, 'src'))).toThrow(RELEASE_CONTRACT_PATH);
  });

  it.each([
    ['malformed JSON', '{ "bundle": '],
    ['a non-object root', '[]'],
    ['a missing section', contractWith((value) => {
      Reflect.deleteProperty(value, 'secrets');
    })],
    ['an unknown top-level key', contractWith((value) => {
      value.extra = {};
    })],
    ['an unknown bundle key', contractWith((value) => {
      value.bundle.extra = 'x';
    })],
    ['a bundle file with a path separator', contractWith((value) => {
      value.bundle.sbom = '../sbom.json';
    })],
    ['two bundle files with the same name', contractWith((value) => {
      value.bundle.sbom = value.bundle.provenance;
    })],
    ['a suffix without a leading dot', contractWith((value) => {
      value.bundle.digestSuffix = 'sha256';
    })],
    ['an unknown bundle role', contractWith((value) => {
      value.bundle.verifyMembers = ['vsix', 'readme'];
    })],
    ['a duplicated bundle role', contractWith((value) => {
      value.bundle.verifyMembers = ['vsix', 'vsix'];
    })],
    ['evidence inside the candidate bundle', contractWith((value) => {
      value.bundle.candidateMembers = ['vsix', 'evidence'];
    })],
    ['a candidate bundle without a VSIX', contractWith((value) => {
      value.bundle.candidateMembers = ['candidate'];
    })],
    ['a non-integer schema version', contractWith((value) => {
      value.schemaVersions.candidate = 1.5;
    })],
    ['a zero schema version', contractWith((value) => {
      value.schemaVersions.evidence = 0;
    })],
    ['an empty candidate key list', contractWith((value) => {
      value.candidateKeys = [];
    })],
    ['a duplicated candidate key', contractWith((value) => {
      value.candidateKeys = ['version', 'version'];
    })],
    ['an artifact prefix without a trailing hyphen', contractWith((value) => {
      value.artifactPrefixes.verifyEvidence = 'verify-evidence';
    })],
    ['a registry URL without a scheme', contractWith((value) => {
      value.registries.openVsx.url = '//open-vsx.org';
    })],
    ['a registry URL with a path', contractWith((value) => {
      value.registries.marketplace.url = 'https://marketplace.visualstudio.com/items';
    })],
    ['a lowercase secret name', contractWith((value) => {
      value.secrets.marketplace = 'vsce_pat';
    })],
    ['a signer outside the workflows directory', contractWith((value) => {
      value.workflows.signerPath = 'scripts/ci.yml';
    })],
    ['a negative budget headroom', contractWith((value) => {
      value.vsixBudget.compressedHeadroomPercent = -1;
    })],
    ['a fractional byte baseline', contractWith((value) => {
      value.vsixBudget.baselineCompressedBytes = 901406.5;
    })],
    ['a string budget', contractWith((value) => {
      value.vsixBudget.maxEntryBytes = '5242880';
    })],
  ])('rejects %s', (_label, source) => {
    expect(() => parseReleaseContract(source)).toThrow(RELEASE_CONTRACT_PATH);
  });
});