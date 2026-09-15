import { describe, expect, it, vi } from 'vitest';
import {
  buildCleanVsixFixture,
  buildZipFixture,
  CLEAN_EXTENSION_IDENTITY,
  CLEAN_PACKAGE_MANIFEST,
  CLEAN_PACKAGE_NLS,
  CLEAN_TRACKED_SOURCE_PATHS,
  cleanVsixFixtureEntries,
  findZipFixtureEntryOffsets,
  toBytes,
} from './fixtures';
import {
  compareNormalizedPaths,
  DEFAULT_OUT_DIR,
  parseVerifyVsixArgs,
  runVerifyVsixCli,
  sha256Hex,
  verifyVsixPackage,
} from '../tools';
import type { VerifyVsixCliDependencies, VsixVerifierIo } from '../tools';

interface FakeIoOptions {
  readonly archive?: Uint8Array;
  readonly archives?: readonly Uint8Array[];
  readonly manifest?: string;
  readonly manifestBytes?: Uint8Array;
  readonly tracked?: readonly string[];
  readonly symlinks?: readonly string[];
  readonly modified?: readonly string[];
  readonly untracked?: readonly string[];
  readonly packageError?: Error;
  readonly packageCreatesBeforeError?: boolean;
  readonly readVsixError?: Error;
  readonly trackedError?: Error;
  readonly untrackedError?: Error;
  readonly symlinkError?: Error;
  readonly writeErrorAt?: 'manifest' | 'digest';
  readonly ensureError?: Error;
  readonly lockAcquireError?: unknown;
  readonly lockReleaseError?: unknown;
  readonly cleanupErrorValue?: unknown;
  readonly cleanupErrorPathBeforePackage?: string;
  readonly cleanupErrorPathAfterPackage?: string;
  readonly staleArtifactPaths?: readonly string[];
}

interface FakeIo {
  readonly io: VsixVerifierIo;
  readonly written: Map<string, string>;
  readonly removed: string[];
  readonly ensured: string[];
  readonly packaged: string[];
  readonly locksAcquired: string[];
  readonly locksReleased: string[];
  readonly artifactBytes: (filePath: string) => Uint8Array | undefined;
  readonly artifactPaths: () => string[];
}

const VSIX_PATH = 'dist/nestro-9.9.9.vsix';
const MANIFEST_PATH = `${VSIX_PATH}.manifest.txt`;
const DIGEST_PATH = `${VSIX_PATH}.sha256`;
const LOCK_PATH = `${VSIX_PATH}.lock`;
const TARGET_ARTIFACT_PATHS = [VSIX_PATH, MANIFEST_PATH, DIGEST_PATH];
const VSX_SCHEMA_URI = 'http://schemas.microsoft.com/developer/vsx-schema/2011';

function outerManifestXml(identity: { readonly name: string; readonly version: string; readonly publisher: string }
  = CLEAN_EXTENSION_IDENTITY): string {
  return `<?xml version="1.0"?><PackageManifest xmlns="${VSX_SCHEMA_URI}"><Metadata><Identity Id="${identity.name}" Version="${identity.version}" Publisher="${identity.publisher}" /></Metadata></PackageManifest>`;
}

function replaceFixtureEntry(path: string, content: string): Uint8Array {
  return buildZipFixture(cleanVsixFixtureEntries().map(entry => entry.path === path ? { ...entry, content } : entry));
}

function createFakeIo(options: FakeIoOptions = {}): FakeIo {
  const files = new Map<string, Uint8Array>([
    ['package.json', options.manifestBytes ?? toBytes(options.manifest ?? CLEAN_PACKAGE_MANIFEST)],
  ]);
  const archive = options.archive ?? buildCleanVsixFixture();
  const written = new Map<string, string>();
  const removed: string[] = [];
  const ensured: string[] = [];
  const packaged: string[] = [];
  const locksAcquired: string[] = [];
  const locksReleased: string[] = [];
  let lockHeld = false;
  for (const stalePath of options.staleArtifactPaths ?? []) {
    files.set(stalePath, toBytes('stale'));
  }

  const io: VsixVerifierIo = {
    packageExtension: (vsixPath: string): Promise<void> => {
      const packageIndex = packaged.length;
      packaged.push(vsixPath);
      if (options.packageError === undefined || options.packageCreatesBeforeError === true) {
        files.set(vsixPath, options.archives?.[packageIndex] ?? archive);
      }
      if (options.packageError) {
        return Promise.reject(options.packageError);
      }
      return Promise.resolve();
    },
    readBinaryFile: (filePath: string): Promise<Uint8Array> => {
      if (filePath.endsWith('.vsix') && options.readVsixError !== undefined) {
        return Promise.reject(options.readVsixError);
      }
      const bytes = files.get(filePath);
      return bytes ? Promise.resolve(bytes) : Promise.reject(new Error(`ENOENT: ${filePath}`));
    },
    writeTextFile: (filePath: string, contents: string): Promise<void> => {
      const writeStage = filePath.endsWith('.manifest.txt') ? 'manifest' : 'digest';
      if (options.writeErrorAt === writeStage) {
        return Promise.reject(new Error(`${writeStage} write failed`));
      }
      written.set(filePath, contents);
      files.set(filePath, toBytes(contents));
      return Promise.resolve();
    },
    removeFile: (filePath: string): Promise<void> => {
      removed.push(filePath);
      if (packaged.length === 0 && options.cleanupErrorPathBeforePackage === filePath) {
        return Promise.reject(new Error(`cannot remove stale ${filePath}`));
      }
      if (packaged.length > 0 && options.cleanupErrorPathAfterPackage === filePath) {
        return Promise.reject(options.cleanupErrorValue ?? new Error(`cannot remove ${filePath}`));
      }
      files.delete(filePath);
      written.delete(filePath);
      return Promise.resolve();
    },
    prepareArtifactDirectory: (dirPath: string): Promise<void> => {
      ensured.push(dirPath);
      return options.ensureError === undefined ? Promise.resolve() : Promise.reject(options.ensureError);
    },
    acquireArtifactLock: (lockPath: string) => {
      locksAcquired.push(lockPath);
      if (options.lockAcquireError !== undefined) {
        return Promise.reject(options.lockAcquireError);
      }
      if (lockHeld) {
        return Promise.reject(new Error(`VSIX artifact lock already exists: ${lockPath}`));
      }
      lockHeld = true;
      return Promise.resolve({
        release: (): Promise<void> => {
          locksReleased.push(lockPath);
          if (options.lockReleaseError !== undefined) {
            return Promise.reject(options.lockReleaseError);
          }
          lockHeld = false;
          return Promise.resolve();
        },
      });
    },
    listTrackedFiles: (): Promise<string[]> => options.trackedError === undefined
      ? Promise.resolve([...(options.tracked ?? CLEAN_TRACKED_SOURCE_PATHS)])
      : Promise.reject(options.trackedError),
    listModifiedTrackedFiles: (): Promise<string[]> => Promise.resolve([...(options.modified ?? [])]),
    listUntrackedFiles: (): Promise<string[]> => options.untrackedError === undefined
      ? Promise.resolve([...(options.untracked ?? [])])
      : Promise.reject(options.untrackedError),
    listSymlinkPaths: (candidatePaths: readonly string[]): Promise<string[]> => options.symlinkError === undefined
      ? Promise.resolve(candidatePaths.filter(candidate => (options.symlinks ?? []).includes(candidate)))
      : Promise.reject(options.symlinkError),
  };

  return {
    io,
    written,
    removed,
    ensured,
    packaged,
    locksAcquired,
    locksReleased,
    artifactBytes: (filePath: string): Uint8Array | undefined => files.get(filePath),
    artifactPaths: (): string[] => [...files.keys()]
      .filter(filePath => filePath !== 'package.json')
      .sort(compareNormalizedPaths),
  };
}

function createCliDependencies(fake: FakeIo): {
  deps: VerifyVsixCliDependencies;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    deps: { io: fake.io, writeOut: line => out.push(line), writeError: line => err.push(line) },
    out,
    err,
  };
}

describe('parseVerifyVsixArgs()', () => {
  it('defaults to the dist output directory and a permissive worktree', () => {
    expect(parseVerifyVsixArgs([])).toEqual({ outDir: DEFAULT_OUT_DIR, requireCleanWorktree: false });
  });

  it('accepts an explicit output directory', () => {
    expect(parseVerifyVsixArgs(['--out-dir', 'build/artifacts']))
      .toEqual({ outDir: 'build/artifacts', requireCleanWorktree: false });
  });

  it('canonicalizes a valid nested output directory', () => {
    expect(parseVerifyVsixArgs(['--out-dir', 'build//nested/./verified/']))
      .toEqual({ outDir: 'build/nested/verified', requireCleanWorktree: false });
  });

  it.each([
    ['the repository root', '.'],
    ['an empty path', ''],
    ['a POSIX absolute path', '/outside/vsix'],
    ['a Windows drive path', 'Z:\\outside\\vsix'],
    ['a Windows UNC path', '\\\\server\\share\\vsix'],
    ['a parent escape', '../outside'],
    ['a nested parent escape', 'build/../../outside'],
    ['a control character', 'dist\nother'],
  ])('rejects %s as an artifact output directory', (_label, outDir) => {
    expect(() => parseVerifyVsixArgs(['--out-dir', outDir]))
      .toThrow('safe relative subdirectory');
  });

  it('accepts the clean-worktree switch the release pipeline needs', () => {
    expect(parseVerifyVsixArgs(['--require-clean-worktree']))
      .toEqual({ outDir: DEFAULT_OUT_DIR, requireCleanWorktree: true });
  });

  it.each([
    ['a missing --out-dir value', ['--out-dir'], '--out-dir requires a directory argument'],
    ['an --out-dir value that is another flag', ['--out-dir', '--verbose'], '--out-dir requires a directory argument'],
    ['an unknown flag', ['--strict'], 'Unknown argument: --strict'],
  ])('rejects %s', (_label, argv, message) => {
    expect(() => parseVerifyVsixArgs(argv)).toThrow(message);
  });
});

describe('sha256Hex()', () => {
  it('matches the well-known digest of empty input', () => {
    expect(sha256Hex(new Uint8Array(0)))
      .toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('verifyVsixPackage()', () => {
  it('rejects an unsafe programmatic output path before filesystem mutation', async () => {
    const fake = createFakeIo();

    await expect(verifyVsixPackage(fake.io, { outDir: '../outside', requireCleanWorktree: false }))
      .rejects.toThrow('safe relative subdirectory');
    expect(fake.ensured).toEqual([]);
    expect(fake.removed).toEqual([]);
    expect(fake.packaged).toEqual([]);
  });

  it('rejects malformed UTF-8/JSON source identity before filesystem mutation', async () => {
    const fake = createFakeIo({ manifestBytes: new Uint8Array([0xff]) });

    await expect(verifyVsixPackage(fake.io, { outDir: 'dist', requireCleanWorktree: false }))
      .rejects.toThrow('package.json is not valid JSON');
    expect(fake.ensured).toEqual([]);
    expect(fake.removed).toEqual([]);
    expect(fake.packaged).toEqual([]);
  });

  it('accepts a safe extension name and full SemVer prerelease/build identity', async () => {
    const identity = {
      name: 'nestro-preview',
      version: '1.2.3-beta.1+build.5',
      publisher: 'greentech-solutions',
      main: './out/extension.cjs',
    };
    const archive = buildZipFixture(cleanVsixFixtureEntries().map((entry) => {
      if (entry.path === 'extension/package.json') {
        return { ...entry, content: JSON.stringify(identity) };
      }
      if (entry.path === 'extension.vsixmanifest') {
        return { ...entry, content: outerManifestXml(identity) };
      }
      return entry;
    }));
    const fake = createFakeIo({ archive, manifest: JSON.stringify(identity) });

    const result = await verifyVsixPackage(fake.io, { outDir: 'build/verified', requireCleanWorktree: false });

    expect(result.vsixPath).toBe('build/verified/nestro-preview-1.2.3-beta.1+build.5.vsix');
    expect(result.artifactsWritten).toBe(true);
  });

  it.each([
    ['a path-bearing name', { name: '../../victim', version: '9.9.9', publisher: 'publisher' }, 'extension name'],
    ['an uppercase name', { name: 'Nestro', version: '9.9.9', publisher: 'publisher' }, 'extension name'],
    ['a control character in the name', { name: 'nes\\tro', version: '9.9.9', publisher: 'publisher' }, 'extension name'],
    ['a path-bearing version', { name: 'nestro', version: '../9.9.9', publisher: 'publisher' }, 'extension version'],
    ['a non-SemVer version', { name: 'nestro', version: 'latest', publisher: 'publisher' }, 'valid SemVer'],
    ['a SemVer with a leading zero', { name: 'nestro', version: '09.9.9', publisher: 'publisher' }, 'valid SemVer'],
    ['an empty prerelease', { name: 'nestro', version: '9.9.9-', publisher: 'publisher' }, 'valid SemVer'],
    ['multiple build separators', { name: 'nestro', version: '9.9.9+a+b', publisher: 'publisher' }, 'valid SemVer'],
    ['an invalid build identifier', { name: 'nestro', version: '9.9.9+bad!', publisher: 'publisher' }, 'valid SemVer'],
  ])('rejects %s before preparing or mutating the output directory', async (_label, identity, message) => {
    const fake = createFakeIo({ manifest: JSON.stringify(identity) });

    await expect(verifyVsixPackage(fake.io, { outDir: 'dist', requireCleanWorktree: false }))
      .rejects.toThrow(message);
    expect(fake.ensured).toEqual([]);
    expect(fake.removed).toEqual([]);
    expect(fake.packaged).toEqual([]);
  });

  it.each([
    ['name', { name: 'other-extension', version: '9.9.9', publisher: 'greentech-solutions', main: './out/extension.cjs' }],
    ['version', { name: 'nestro', version: '9.9.8', publisher: 'greentech-solutions', main: './out/extension.cjs' }],
    ['publisher', { name: 'nestro', version: '9.9.9', publisher: 'other-publisher', main: './out/extension.cjs' }],
  ])('removes all artifacts when the packaged %s differs from the source identity', async (_label, identity) => {
    const archive = buildZipFixture(cleanVsixFixtureEntries().map(entry => entry.path === 'extension/package.json'
      ? { ...entry, content: JSON.stringify(identity) }
      : entry));
    const fake = createFakeIo({ archive });

    await expect(verifyVsixPackage(fake.io, { outDir: 'dist', requireCleanWorktree: false }))
      .rejects.toThrow('does not match source package.json');
    expect(fake.artifactPaths()).toEqual([]);
    expect(fake.written).toEqual(new Map());
  });

  it('removes all artifacts when the VSIX has no unique packaged manifest identity', async () => {
    const archive = buildZipFixture(cleanVsixFixtureEntries()
      .filter(entry => entry.path !== 'extension/package.json'));
    const fake = createFakeIo({ archive });

    await expect(verifyVsixPackage(fake.io, { outDir: 'dist', requireCleanWorktree: false }))
      .rejects.toThrow('must contain exactly one extension/package.json');
    expect(fake.artifactPaths()).toEqual([]);
  });

  it('removes all artifacts when the VSIX contains a duplicate packaged manifest path', async () => {
    const packageEntry = cleanVsixFixtureEntries().find(entry => entry.path === 'extension/package.json');
    const archive = buildZipFixture([
      ...cleanVsixFixtureEntries(),
      { path: 'extension/package.json', content: packageEntry?.content ?? CLEAN_PACKAGE_MANIFEST },
    ]);
    const fake = createFakeIo({ archive });

    await expect(verifyVsixPackage(fake.io, { outDir: 'dist', requireCleanWorktree: false }))
      .rejects.toThrow(/duplicate archive entry path.*extension\/package\.json/i);
    expect(fake.artifactPaths()).toEqual([]);
  });

  it('removes all artifacts when the packaged identity is not valid UTF-8 JSON', async () => {
    const archive = buildZipFixture(cleanVsixFixtureEntries().map(entry => entry.path === 'extension/package.json'
      ? { ...entry, content: new Uint8Array([0xff]) }
      : entry));
    const fake = createFakeIo({ archive });

    await expect(verifyVsixPackage(fake.io, { outDir: 'dist', requireCleanWorktree: false }))
      .rejects.toThrow('packaged extension/package.json is not valid JSON');
    expect(fake.artifactPaths()).toEqual([]);
    expect(fake.written).toEqual(new Map());
  });

  it.each([
    [
      'missing outer manifest',
      buildZipFixture(cleanVsixFixtureEntries().filter(entry => entry.path !== 'extension.vsixmanifest')),
      'exactly one extension.vsixmanifest',
    ],
    [
      'duplicate outer manifest path',
      buildZipFixture([
        ...cleanVsixFixtureEntries(),
        { path: 'extension.vsixmanifest', content: outerManifestXml() },
      ]),
      'duplicate archive entry path',
    ],
    [
      'malformed outer XML',
      replaceFixtureEntry('extension.vsixmanifest', '<PackageManifest><Identity'),
      'extension.vsixmanifest is not valid XML',
    ],
    [
      'missing outer Identity',
      replaceFixtureEntry(
        'extension.vsixmanifest',
        `<PackageManifest xmlns="${VSX_SCHEMA_URI}"><Metadata /></PackageManifest>`,
      ),
      'exactly one Identity',
    ],
    [
      'duplicate outer Identity',
      replaceFixtureEntry(
        'extension.vsixmanifest',
        `<PackageManifest xmlns="${VSX_SCHEMA_URI}"><Metadata>
          <Identity Id="nestro" Version="9.9.9" Publisher="greentech-solutions" />
          <Identity Id="nestro" Version="9.9.9" Publisher="greentech-solutions" />
        </Metadata></PackageManifest>`,
      ),
      'exactly one Identity',
    ],
    [
      'nested PackageManifest identity decoy',
      replaceFixtureEntry(
        'extension.vsixmanifest',
        `<PackageManifest xmlns="${VSX_SCHEMA_URI}"><Wrapper><PackageManifest><Metadata>
          <Identity Id="nestro" Version="9.9.9" Publisher="greentech-solutions" />
        </Metadata></PackageManifest></Wrapper></PackageManifest>`,
      ),
      'document root',
    ],
    [
      'mismatched outer name',
      replaceFixtureEntry('extension.vsixmanifest', outerManifestXml({ ...CLEAN_EXTENSION_IDENTITY, name: 'other' })),
      'does not match source package.json',
    ],
    [
      'mismatched outer version',
      replaceFixtureEntry('extension.vsixmanifest', outerManifestXml({ ...CLEAN_EXTENSION_IDENTITY, version: '9.9.8' })),
      'does not match source package.json',
    ],
    [
      'mismatched outer publisher',
      replaceFixtureEntry(
        'extension.vsixmanifest',
        outerManifestXml({ ...CLEAN_EXTENSION_IDENTITY, publisher: 'other-publisher' }),
      ),
      'does not match source package.json',
    ],
  ])('fails closed with 0/3 artifacts for %s', async (_label, archive, message) => {
    const fake = createFakeIo({ archive });

    await expect(verifyVsixPackage(fake.io, { outDir: 'dist', requireCleanWorktree: false }))
      .rejects.toThrow(message);
    expect(fake.artifactPaths()).toEqual([]);
    expect(fake.written).toEqual(new Map());
  });

  it('packages, verifies and publishes the artifacts for a clean package', async () => {
    const fake = createFakeIo();

    const result = await verifyVsixPackage(fake.io, { outDir: 'dist', requireCleanWorktree: false });

    expect(result.report.violations).toEqual([]);
    expect(fake.ensured).toEqual(['dist']);
    expect(fake.packaged).toEqual([VSIX_PATH]);
    expect(fake.locksAcquired).toEqual([LOCK_PATH]);
    expect(fake.locksReleased).toEqual([LOCK_PATH]);
    expect(result.vsixPath).toBe(VSIX_PATH);
    expect(result.artifactsWritten).toBe(true);
    expect(fake.removed).toEqual(TARGET_ARTIFACT_PATHS);
    expect(fake.artifactPaths()).toEqual([...TARGET_ARTIFACT_PATHS].sort(compareNormalizedPaths));
    expect(fake.written.get(DIGEST_PATH)).toBe(`${result.digest}  nestro-9.9.9.vsix\n`);
    expect(result.digest).toBe(sha256Hex(buildCleanVsixFixture()));
  });

  it('writes a manifest of per-entry digests ordered by archive path', async () => {
    const fake = createFakeIo();

    const result = await verifyVsixPackage(fake.io, { outDir: 'dist', requireCleanWorktree: false });
    const manifest = fake.written.get('dist/nestro-9.9.9.vsix.manifest.txt') ?? '';
    const paths = manifest.trimEnd().split('\n').map(line => line.split('  ')[1]);

    expect(paths).toEqual([
      '[Content_Types].xml',
      'extension.vsixmanifest',
      'extension/LICENSE.txt',
      'extension/changelog.md',
      'extension/images/pick-version.png',
      'extension/out/chunk-AbCdEf12.cjs',
      'extension/out/extension.cjs',
      'extension/package.json',
      'extension/package.nls.json',
      'extension/readme.md',
      'extension/resources/icon.png',
      'extension/resources/icon.svg',
    ]);
    expect(manifest).toContain(`${sha256Hex(toBytes(CLEAN_PACKAGE_MANIFEST))}  extension/package.json`);
    expect(manifest).toContain(`${sha256Hex(toBytes(CLEAN_PACKAGE_NLS))}  extension/package.nls.json`);
    expect(result.manifestLines).toHaveLength(12);
  });

  it('deletes a rejected package and withholds its artifacts', async () => {
    const archive = buildZipFixture([
      ...cleanVsixFixtureEntries(),
      { path: 'extension/CODESTYLE.md', content: '# Codestyle\n' },
    ]);
    const fake = createFakeIo({ archive });

    const result = await verifyVsixPackage(fake.io, { outDir: 'dist', requireCleanWorktree: false });

    expect(result.artifactsWritten).toBe(false);
    expect(result.report.violations).toContainEqual({
      kind: 'forbidden-file',
      path: 'CODESTYLE.md',
      detail: 'forbidden class "internal-doc"',
    });
    expect(fake.written.size).toBe(0);
    expect(fake.removed).toEqual([...TARGET_ARTIFACT_PATHS, ...TARGET_ARTIFACT_PATHS]);
    expect(fake.artifactPaths()).toEqual([]);
  });

  it('removes only the exact stale artifact set before packaging', async () => {
    const unrelatedPath = 'dist/unrelated.txt';
    const fake = createFakeIo({ staleArtifactPaths: [...TARGET_ARTIFACT_PATHS, unrelatedPath] });

    await verifyVsixPackage(fake.io, { outDir: 'dist', requireCleanWorktree: false });

    expect(fake.removed.slice(0, 3)).toEqual(TARGET_ARTIFACT_PATHS);
    expect(fake.artifactPaths()).toEqual([...TARGET_ARTIFACT_PATHS, unrelatedPath].sort(compareNormalizedPaths));
  });

  it('removes a partial package and stale sidecars when packaging creates output and then throws', async () => {
    const packageError = new Error('vsce package failed after writing output');
    const fake = createFakeIo({
      packageError,
      packageCreatesBeforeError: true,
      staleArtifactPaths: [MANIFEST_PATH, DIGEST_PATH],
    });

    await expect(verifyVsixPackage(fake.io, { outDir: 'dist', requireCleanWorktree: false }))
      .rejects.toBe(packageError);
    expect(fake.artifactPaths()).toEqual([]);
  });

  it('does not package when stale artifact cleanup fails and identifies the exact path', async () => {
    const fake = createFakeIo({
      staleArtifactPaths: [MANIFEST_PATH],
      cleanupErrorPathBeforePackage: MANIFEST_PATH,
    });

    await expect(verifyVsixPackage(fake.io, { outDir: 'dist', requireCleanWorktree: false }))
      .rejects.toThrow(/cleanup failed before packaging.*manifest\.txt/i);
    expect(fake.packaged).toEqual([]);
    expect(fake.removed).toEqual(TARGET_ARTIFACT_PATHS);
  });

  it('does not touch stale artifacts when safe output directory preparation fails', async () => {
    const ensureError = new Error('cannot prepare output directory');
    const fake = createFakeIo({
      ensureError,
      staleArtifactPaths: TARGET_ARTIFACT_PATHS,
    });

    await expect(verifyVsixPackage(fake.io, { outDir: 'dist', requireCleanWorktree: false }))
      .rejects.toBe(ensureError);
    expect(fake.removed).toEqual([]);
    expect(fake.artifactPaths()).toEqual([...TARGET_ARTIFACT_PATHS].sort(compareNormalizedPaths));
    expect(fake.packaged).toEqual([]);
  });

  it('does not touch current artifacts when another verifier holds the lock', async () => {
    const lockError = new Error(`VSIX artifact lock already exists: ${LOCK_PATH}`);
    const fake = createFakeIo({
      lockAcquireError: lockError,
      staleArtifactPaths: TARGET_ARTIFACT_PATHS,
    });

    await expect(verifyVsixPackage(fake.io, { outDir: 'dist', requireCleanWorktree: false }))
      .rejects.toBe(lockError);
    expect(fake.removed).toEqual([]);
    expect(fake.packaged).toEqual([]);
    expect(fake.artifactPaths()).toEqual([...TARGET_ARTIFACT_PATHS].sort(compareNormalizedPaths));
  });

  it('fails closed and removes successful artifacts when lock release fails', async () => {
    const fake = createFakeIo({ lockReleaseError: new Error('cannot release lock') });

    const failure = await verifyVsixPackage(fake.io, { outDir: 'dist', requireCleanWorktree: false })
      .then(() => null, error => error as Error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure?.message).toContain('cannot release lock');
    expect(failure?.message.startsWith(';')).toBe(false);
    expect(failure?.message).not.toContain('undefined');
    expect(fake.artifactPaths()).toEqual([]);
    expect(fake.locksReleased).toEqual([LOCK_PATH]);
  });

  it('reports operation and lock release failures together while keeping artifacts absent', async () => {
    const fake = createFakeIo({
      lockReleaseError: new Error('cannot release lock'),
      packageCreatesBeforeError: true,
      packageError: new Error('vsce package failed'),
    });

    await expect(verifyVsixPackage(fake.io, { outDir: 'dist', requireCleanWorktree: false }))
      .rejects.toThrow(/vsce package failed.*lock release failed.*artifacts were removed/i);
    expect(fake.artifactPaths()).toEqual([]);
  });

  it('reports exact artifact cleanup failures after a lock release failure', async () => {
    const fake = createFakeIo({
      cleanupErrorPathAfterPackage: VSIX_PATH,
      cleanupErrorValue: 'cannot remove final VSIX',
      lockReleaseError: new Error('cannot release lock'),
    });

    await expect(verifyVsixPackage(fake.io, { outDir: 'dist', requireCleanWorktree: false }))
      .rejects.toThrow(/lock release failed.*cleanup also failed.*cannot remove final VSIX/i);
    expect(fake.artifactPaths()).toEqual([VSIX_PATH]);
  });

  it('fails a concurrent second verifier without letting it touch the first run artifacts', async () => {
    const secondArchive = buildZipFixture(cleanVsixFixtureEntries().map(entry => entry.path === 'extension/readme.md'
      ? { ...entry, content: '# Concurrent package B\n' }
      : entry));
    const fake = createFakeIo({ archives: [buildCleanVsixFixture(), secondArchive] });
    const originalPackage = fake.io.packageExtension.bind(fake.io);
    let packageCalls = 0;
    let markFirstPackageStarted: () => void = () => undefined;
    let continueFirstPackage: () => void = () => undefined;
    const firstPackageStarted = new Promise<void>((resolve) => {
      markFirstPackageStarted = resolve;
    });
    const firstPackageMayFinish = new Promise<void>((resolve) => {
      continueFirstPackage = resolve;
    });
    vi.spyOn(fake.io, 'packageExtension').mockImplementation(async (vsixPath) => {
      packageCalls++;
      await originalPackage(vsixPath);
      if (packageCalls === 1) {
        markFirstPackageStarted();
        await firstPackageMayFinish;
      }
    });

    const firstRun = verifyVsixPackage(fake.io, { outDir: 'dist', requireCleanWorktree: false });
    await firstPackageStarted;
    const secondOutcome = await verifyVsixPackage(fake.io, { outDir: 'dist', requireCleanWorktree: false })
      .then(result => ({ result }), error => ({ error: error as unknown }));
    continueFirstPackage();
    const firstResult = await firstRun;

    expect(secondOutcome).toHaveProperty('error');
    expect((secondOutcome as { error: Error }).error.message).toContain('lock already exists');
    expect(firstResult.artifactsWritten).toBe(true);
    expect(fake.removed).toEqual(TARGET_ARTIFACT_PATHS);
    expect(fake.packaged).toEqual([VSIX_PATH]);
    expect(fake.locksAcquired).toEqual([LOCK_PATH, LOCK_PATH]);
    expect(fake.locksReleased).toEqual([LOCK_PATH]);
    expect(fake.artifactPaths()).toEqual([...TARGET_ARTIFACT_PATHS].sort(compareNormalizedPaths));
    const finalVsixBytes = fake.artifactBytes(VSIX_PATH);
    expect(finalVsixBytes).toBeDefined();
    expect(fake.written.get(DIGEST_PATH)).toBe(`${sha256Hex(finalVsixBytes ?? new Uint8Array())}  nestro-9.9.9.vsix\n`);
  });

  it.each([
    ['archive read', { readVsixError: new Error('archive read failed') }, 'archive read failed'],
    ['archive parse', { archive: new Uint8Array(4) }, 'too small'],
  ])('removes all artifacts after %s failure', async (_label, options, expectedMessage) => {
    const fake = createFakeIo(options);

    await expect(verifyVsixPackage(fake.io, { outDir: 'dist', requireCleanWorktree: false }))
      .rejects.toThrow(expectedMessage);
    expect(fake.artifactPaths()).toEqual([]);
  });

  it.each([
    [
      'a central/local filename mismatch',
      (): Uint8Array => {
        const archive = buildCleanVsixFixture();
        const offsets = findZipFixtureEntryOffsets(archive, 'extension/readme.md');
        archive.set(toBytes('extension/secret.md'), offsets.localNameOffset);
        return archive;
      },
      'local filename does not match central filename',
    ],
    [
      'a central/local flags mismatch',
      (): Uint8Array => {
        const archive = buildCleanVsixFixture();
        const offsets = findZipFixtureEntryOffsets(archive, 'extension/readme.md');
        new DataView(archive.buffer).setUint16(offsets.localHeaderOffset + 6, 0x0801, true);
        return archive;
      },
      'local flags do not match central flags',
    ],
    [
      'a central/local compression-method mismatch',
      (): Uint8Array => {
        const archive = buildCleanVsixFixture();
        const offsets = findZipFixtureEntryOffsets(archive, 'extension/readme.md');
        new DataView(archive.buffer).setUint16(offsets.localHeaderOffset + 8, 0, true);
        return archive;
      },
      'local compression method does not match central',
    ],
    [
      'a corrupt data descriptor',
      (): Uint8Array => {
        const archive = buildZipFixture(cleanVsixFixtureEntries().map(entry => entry.path === 'extension/readme.md'
          ? { ...entry, useDataDescriptor: true }
          : entry));
        const offsets = findZipFixtureEntryOffsets(archive, 'extension/readme.md');
        const view = new DataView(archive.buffer);
        const compressedSize = view.getUint32(offsets.centralHeaderOffset + 20, true);
        const descriptorOffset = offsets.localNameOffset + offsets.localNameLength + compressedSize;
        view.setUint32(descriptorOffset + 4, 1, true);
        return archive;
      },
      'data descriptor does not match central metadata',
    ],
    [
      'invalid UTF-8 in an archive path',
      (): Uint8Array => {
        const archive = buildCleanVsixFixture();
        const offsets = findZipFixtureEntryOffsets(archive, 'extension/readme.md');
        archive[offsets.centralNameOffset] = 0xff;
        return archive;
      },
      'central filename is not valid UTF-8',
    ],
    [
      'a directory-like entry carrying hidden token bytes',
      (): Uint8Array => buildZipFixture([
        ...cleanVsixFixtureEntries(),
        { path: 'extension/hidden/', content: 'npm_secret_token_value', method: 'stored' },
      ]),
      'explicit directory entry is not allowed',
    ],
    [
      'a file/directory path collision',
      (): Uint8Array => buildZipFixture([
        ...cleanVsixFixtureEntries(),
        { path: 'extension/readme.md/', content: '', method: 'stored' },
      ]),
      'explicit directory entry is not allowed',
    ],
    [
      'an entry whose local filename extends beyond archive bounds',
      (): Uint8Array => {
        const archive = buildCleanVsixFixture();
        const offsets = findZipFixtureEntryOffsets(archive, 'extension/readme.md');
        new DataView(archive.buffer).setUint16(offsets.localHeaderOffset + 26, 0xffff, true);
        return archive;
      },
      'local filename and extra data',
    ],
  ])('cleans 0/3 artifacts and no sidecars for %s', async (_label, archiveFactory, message) => {
    const fake = createFakeIo({ archive: archiveFactory() });

    await expect(verifyVsixPackage(fake.io, { outDir: 'dist', requireCleanWorktree: false }))
      .rejects.toThrow(message);
    expect(fake.artifactPaths()).toEqual([]);
    expect(fake.written).toEqual(new Map());
  });

  it.each([
    ['tracked file list', { trackedError: new Error('git ls-files failed') }, false, 'git ls-files failed'],
    ['strict untracked file list', { untrackedError: new Error('git untracked failed') }, true, 'git untracked failed'],
  ])('removes all artifacts after %s failure', async (_label, options, requireCleanWorktree, expectedMessage) => {
    const fake = createFakeIo(options);

    await expect(verifyVsixPackage(fake.io, { outDir: 'dist', requireCleanWorktree }))
      .rejects.toThrow(expectedMessage);
    expect(fake.artifactPaths()).toEqual([]);
  });

  it('removes all artifacts when symlink inspection fails', async () => {
    const symlinkError = new Error('lstat images failed: permission denied');
    const fake = createFakeIo({ symlinkError });

    await expect(verifyVsixPackage(fake.io, { outDir: 'dist', requireCleanWorktree: false }))
      .rejects.toBe(symlinkError);
    expect(fake.artifactPaths()).toEqual([]);
  });

  it.each([
    ['manifest', 'manifest write failed'],
    ['digest', 'digest write failed'],
  ] as const)('removes the VSIX and partial sidecars when the %s write fails', async (writeErrorAt, message) => {
    const fake = createFakeIo({ writeErrorAt });

    await expect(verifyVsixPackage(fake.io, { outDir: 'dist', requireCleanWorktree: false }))
      .rejects.toThrow(message);
    expect(fake.artifactPaths()).toEqual([]);
  });

  it('removes stale sidecars as well as the current VSIX after policy rejection', async () => {
    const archive = buildZipFixture([
      ...cleanVsixFixtureEntries(),
      { path: 'extension/CODESTYLE.md', content: '# Codestyle\n' },
    ]);
    const fake = createFakeIo({ archive, staleArtifactPaths: [MANIFEST_PATH, DIGEST_PATH] });

    const result = await verifyVsixPackage(fake.io, { outDir: 'dist', requireCleanWorktree: false });

    expect(result.artifactsWritten).toBe(false);
    expect(fake.artifactPaths()).toEqual([]);
  });

  it('reports both the original failure and an artifact cleanup failure', async () => {
    const fake = createFakeIo({
      archive: new Uint8Array(4),
      cleanupErrorPathAfterPackage: VSIX_PATH,
    });

    await expect(verifyVsixPackage(fake.io, { outDir: 'dist', requireCleanWorktree: false }))
      .rejects.toThrow(/too small.*cleanup.*dist\/nestro-9\.9\.9\.vsix/i);
  });

  it('passes symlink candidates from the archive to the io layer', async () => {
    const fake = createFakeIo({ symlinks: ['images'] });
    const listSymlinkPaths = vi.spyOn(fake.io, 'listSymlinkPaths');

    const result = await verifyVsixPackage(fake.io, { outDir: 'dist', requireCleanWorktree: false });

    expect(listSymlinkPaths.mock.calls[0][0]).toContain('images/pick-version.png');
    expect(result.report.violations).toContainEqual({
      kind: 'symlink',
      path: 'images',
      detail: 'packaged path resolves through a symlink on disk',
    });
  });

  it.each([
    ['JSON null', 'null'],
    ['a JSON array', '[]'],
    ['no name', JSON.stringify({ version: '1.0.0', publisher: 'publisher' })],
    ['no version', JSON.stringify({ name: 'nestro', publisher: 'publisher' })],
    ['no publisher', JSON.stringify({ name: 'nestro', version: '1.0.0' })],
    ['a non-string publisher', JSON.stringify({ name: 'nestro', version: '1.0.0', publisher: 42 })],
  ])('refuses to run when the repository manifest has %s', async (_label, manifest) => {
    const fake = createFakeIo({ manifest });

    await expect(verifyVsixPackage(fake.io, { outDir: 'dist', requireCleanWorktree: false }))
      .rejects.toThrow(/package\.json.*object.*string "name", "version", and "publisher"/i);
    expect(fake.ensured).toEqual([]);
    expect(fake.removed).toEqual([]);
    expect(fake.packaged).toEqual([]);
  });
});

describe('runVerifyVsixCli()', () => {
  it('rejects an unsafe output directory before preparing, locking, removing, or packaging', async () => {
    const fake = createFakeIo();
    const { deps, out, err } = createCliDependencies(fake);

    await expect(runVerifyVsixCli(['--out-dir', '../outside'], deps)).resolves.toBe(1);

    expect(err.join('\n')).toContain('safe relative subdirectory');
    expect(out).toEqual([]);
    expect(fake.ensured).toEqual([]);
    expect(fake.locksAcquired).toEqual([]);
    expect(fake.removed).toEqual([]);
    expect(fake.packaged).toEqual([]);
  });

  it('prints the normalized source manifest to stdout and the summary to stderr', async () => {
    const fake = createFakeIo();
    const { deps, out, err } = createCliDependencies(fake);

    await expect(runVerifyVsixCli([], deps)).resolves.toBe(0);
    expect(out).toContain('out/extension.cjs');
    expect(out).toContain('README.md');
    expect(err.join('\n')).toContain('VSIX verified: 10/26 files');
    expect(err.some(line => line.includes('sha256:'))).toBe(true);
  });

  it('reports every violation on stderr and fails', async () => {
    const archive = buildZipFixture([
      ...cleanVsixFixtureEntries(),
      { path: 'extension/out/extension.cjs.map', content: '{}' },
    ]);
    const { deps, out, err } = createCliDependencies(createFakeIo({ archive }));

    await expect(runVerifyVsixCli([], deps)).resolves.toBe(1);
    expect(err[0]).toContain('VSIX policy rejected');
    expect(err.join('\n')).toContain('[forbidden-file] out/extension.cjs.map');
    expect(err.join('\n')).toContain('Rejected VSIX artifacts removed');
    expect(out).toEqual([]);
  });

  it('keeps stdout empty on rejection so a downstream grep on the manifest cannot report success', async () => {
    const archive = buildZipFixture([
      ...cleanVsixFixtureEntries(),
      { path: 'extension/CODESTYLE.md', content: '# Codestyle\n' },
    ]);
    const { deps, out, err } = createCliDependencies(createFakeIo({ archive }));

    await expect(runVerifyVsixCli([], deps)).resolves.toBe(1);
    // The exact shape of release.yml step 6: `pnpm check:vsce | grep -Fxq 'out/extension.cjs'`
    // under `bash -e` without pipefail takes its status from grep, so the entrypoint line
    // must not reach stdout unless the package was accepted.
    expect(out).not.toContain('out/extension.cjs');
    expect(out).toEqual([]);
    expect(err.some(line => line.includes('[forbidden-file] CODESTYLE.md'))).toBe(true);
  });

  it('emits the manifest on stdout only after the package is accepted', async () => {
    const { deps, out } = createCliDependencies(createFakeIo());

    await expect(runVerifyVsixCli([], deps)).resolves.toBe(0);
    expect(out).toContain('out/extension.cjs');
    expect(out).toHaveLength(10);
  });

  it('warns on stderr about a locally modified packaged file but still accepts the package', async () => {
    const { deps, out, err } = createCliDependencies(createFakeIo({ modified: ['README.md'] }));

    await expect(runVerifyVsixCli([], deps)).resolves.toBe(0);
    expect(err.join('\n')).toContain('VSIX warning: README.md is tracked but modified');
    expect(out).toContain('out/extension.cjs');
  });

  it('fails on a locally modified packaged file when the clean-worktree switch is set', async () => {
    const { deps, out, err } = createCliDependencies(createFakeIo({ modified: ['README.md'] }));

    await expect(runVerifyVsixCli(['--require-clean-worktree'], deps)).resolves.toBe(1);
    expect(err.join('\n')).toContain('[modified-tracked-file] README.md');
    expect(out).toEqual([]);
  });

  it.each([
    'src/extension.ts',
    'tsdown.config.mts',
  ])('fails strict verification when build input %s is modified', async (sourcePath) => {
    const { deps, out, err } = createCliDependencies(createFakeIo({ modified: [sourcePath] }));

    await expect(runVerifyVsixCli(['--require-clean-worktree'], deps)).resolves.toBe(1);
    expect(err.join('\n')).toContain(`[modified-tracked-file] ${sourcePath}`);
    expect(out).toEqual([]);
  });

  it('fails strict verification when an untracked build input is present', async () => {
    const sourcePath = 'src/generatedBuildInput.ts';
    const { deps, out, err } = createCliDependencies(createFakeIo({ untracked: [sourcePath] }));

    await expect(runVerifyVsixCli(['--require-clean-worktree'], deps)).resolves.toBe(1);
    expect(err.join('\n')).toContain(`[untracked-worktree-file] ${sourcePath}`);
    expect(out).toEqual([]);
  });

  it('excludes only its own active lock from a strict custom-output worktree scan', async () => {
    const ownLock = 'build/verified/nestro-9.9.9.vsix.lock';
    const fake = createFakeIo({ untracked: [ownLock] });
    const { deps, out, err } = createCliDependencies(fake);

    await expect(runVerifyVsixCli(['--require-clean-worktree', '--out-dir', 'build/verified'], deps))
      .resolves.toBe(0);
    expect(err.join('\n')).not.toContain('[untracked-worktree-file]');
    expect(out).toContain('out/extension.cjs');
  });

  it('still rejects every other untracked lock beside its exact active lock', async () => {
    const ownLock = 'build/verified/nestro-9.9.9.vsix.lock';
    const otherLock = 'build/verified/other.vsix.lock';
    const fake = createFakeIo({ untracked: [ownLock, otherLock] });
    const { deps, out, err } = createCliDependencies(fake);

    await expect(runVerifyVsixCli(['--require-clean-worktree', '--out-dir', 'build/verified'], deps))
      .resolves.toBe(1);
    expect(err.join('\n')).not.toContain(`[untracked-worktree-file] ${ownLock}`);
    expect(err.join('\n')).toContain(`[untracked-worktree-file] ${otherLock}`);
    expect(out).toEqual([]);
  });

  it('still reports warnings on stderr when the package is rejected', async () => {
    const archive = buildZipFixture([
      ...cleanVsixFixtureEntries(),
      { path: 'extension/CODESTYLE.md', content: '# Codestyle\n' },
    ]);
    const { deps, out, err } = createCliDependencies(createFakeIo({ archive, modified: ['README.md'] }));

    await expect(runVerifyVsixCli([], deps)).resolves.toBe(1);
    expect(err.join('\n')).toContain('VSIX warning: README.md is tracked but modified');
    expect(err.join('\n')).toContain('[forbidden-file] CODESTYLE.md');
    expect(out).toEqual([]);
  });

  it('fails when packaging itself fails', async () => {
    const fake = createFakeIo({ packageError: new Error('vsce package failed: exit 1') });
    const { deps, err } = createCliDependencies(fake);

    await expect(runVerifyVsixCli([], deps)).resolves.toBe(1);
    expect(err.join('\n')).toContain('VSIX verification failed: vsce package failed: exit 1');
  });

  it('describes a non-Error lock acquisition failure', async () => {
    const { deps, err } = createCliDependencies(createFakeIo({ lockAcquireError: 'lock device failed' }));

    await expect(runVerifyVsixCli([], deps)).resolves.toBe(1);
    expect(err.join('\n')).toContain('VSIX verification failed: lock device failed');
  });

  it('fails on an unusable archive without throwing', async () => {
    const fake = createFakeIo({ archive: new Uint8Array(4) });
    const { deps, err } = createCliDependencies(fake);

    await expect(runVerifyVsixCli([], deps)).resolves.toBe(1);
    expect(err.join('\n')).toContain('too small');
  });

  it('fails on bad arguments before packaging anything', async () => {
    const fake = createFakeIo();
    const { deps, err } = createCliDependencies(fake);

    await expect(runVerifyVsixCli(['--nope'], deps)).resolves.toBe(1);
    expect(err.join('\n')).toContain('Unknown argument: --nope');
    expect(fake.packaged).toEqual([]);
  });

  it('honours a custom output directory', async () => {
    const fake = createFakeIo();
    const { deps } = createCliDependencies(fake);

    await expect(runVerifyVsixCli(['--out-dir', 'build/verified'], deps)).resolves.toBe(0);
    expect(fake.packaged).toEqual(['build/verified/nestro-9.9.9.vsix']);
    expect([...fake.written.keys()]).toEqual([
      'build/verified/nestro-9.9.9.vsix.manifest.txt',
      'build/verified/nestro-9.9.9.vsix.sha256',
    ]);
  });
});