import { describe, expect, it } from 'vitest';
import { archiveEntry, CLEAN_TRACKED_SOURCE_PATHS, cleanVsixArchiveEntries, toBytes } from './fixtures';
import {
  classifyForbidden,
  CLEAN_BASELINE_COMPRESSED_BYTES,
  CLEAN_BASELINE_PACKAGED_FILE_COUNT,
  collectSymlinkCandidates,
  COMPRESSED_SIZE_BUDGET_BYTES,
  evaluateVsixPolicy,
  PACKAGED_FILE_COUNT_BUDGET,
  resolveBundleClosure,
  toSourcePath,
  VSIX_SECRET_PATTERNS,
} from '../tools';
import type { ForbiddenClass, PolicyViolation, VsixArchiveEntry, VsixPolicyReport } from '../tools';

const CLEAN_COMPRESSED_BYTES = 1024;

interface EvaluateOverrides {
  readonly entries?: readonly VsixArchiveEntry[];
  readonly compressedBytes?: number;
  readonly trackedSourcePaths?: readonly string[];
  readonly symlinkSourcePaths?: readonly string[];
  readonly modifiedTrackedPaths?: readonly string[];
  readonly untrackedWorktreePaths?: readonly string[];
  readonly requireCleanWorktree?: boolean;
}

function evaluate(overrides: EvaluateOverrides = {}): VsixPolicyReport {
  return evaluateVsixPolicy({
    entries: overrides.entries ?? cleanVsixArchiveEntries(),
    compressedBytes: overrides.compressedBytes ?? CLEAN_COMPRESSED_BYTES,
    trackedSourcePaths: overrides.trackedSourcePaths ?? CLEAN_TRACKED_SOURCE_PATHS,
    symlinkSourcePaths: overrides.symlinkSourcePaths ?? [],
    modifiedTrackedPaths: overrides.modifiedTrackedPaths ?? [],
    untrackedWorktreePaths: overrides.untrackedWorktreePaths ?? [],
    requireCleanWorktree: overrides.requireCleanWorktree ?? false,
  });
}

function withExtraFile(packagePath: string, content = 'x'): VsixArchiveEntry[] {
  return [...cleanVsixArchiveEntries(), archiveEntry(`extension/${packagePath}`, content)];
}

function replacing(archivePath: string, content: string | Uint8Array, overrides: Partial<VsixArchiveEntry> = {}): VsixArchiveEntry[] {
  return [
    ...cleanVsixArchiveEntries().filter(entry => entry.path !== archivePath),
    archiveEntry(archivePath, content, overrides),
  ];
}

function without(archivePath: string): VsixArchiveEntry[] {
  return cleanVsixArchiveEntries().filter(entry => entry.path !== archivePath);
}

function kinds(report: VsixPolicyReport): string[] {
  return report.violations.map((violation: PolicyViolation) => violation.kind);
}

describe('evaluateVsixPolicy() — clean package', () => {
  it('accepts the clean package and reports its normalized content', () => {
    const report = evaluate();

    expect(report.violations).toEqual([]);
    expect(report.packagedFileCount).toBe(10);
    expect(report.packagePaths).toEqual([
      'LICENSE.txt',
      'changelog.md',
      'images/pick-version.png',
      'out/chunk-AbCdEf12.cjs',
      'out/extension.cjs',
      'package.json',
      'package.nls.json',
      'readme.md',
      'resources/icon.png',
      'resources/icon.svg',
    ]);
    expect(report.sourcePaths).toContain('out/extension.cjs');
    expect(report.sourcePaths).toContain('README.md');
    expect(report.sourcePaths).toContain('LICENSE');
    expect(report.bundleClosure).toEqual(['out/chunk-AbCdEf12.cjs', 'out/extension.cjs']);
  });

  it('maps packaged documents back to the repository files vsce renamed', () => {
    expect(toSourcePath('readme.md')).toBe('README.md');
    expect(toSourcePath('changelog.md')).toBe('CHANGELOG.md');
    expect(toSourcePath('LICENSE.txt')).toBe('LICENSE');
    expect(toSourcePath('out/extension.cjs')).toBe('out/extension.cjs');
    expect(toSourcePath('package.nls.json')).toBe('package.nls.json');
  });
});

describe('evaluateVsixPolicy() — forbidden classes', () => {
  const forbiddenFixtures: readonly [ForbiddenClass, string][] = [
    ['source-map', 'out/extension.cjs.map'],
    ['cache', '.pnpm-store/v11/index.db'],
    ['cache', 'node_modules/left-pad/index.js'],
    ['cache', '.eslintcache'],
    ['cache', 'coverage/lcov.info'],
    ['test', 'out/test/extension.test.js'],
    ['test', 'out/providers/treeBuilder.unit.test.js'],
    ['internal-doc', 'workflow/audit/plan.md'],
    ['internal-doc', 'CODESTYLE.md'],
    ['internal-doc', 'AGENTS.md'],
    ['internal-doc', 'ARCHITECTURE.md'],
    ['internal-doc', 'docs/audit/notes.md'],
    ['source', 'src/extension.ts'],
    ['source', 'tsdown.config.mts'],
    ['source', 'vitest.config.ts'],
    ['vcs-or-ci', '.github/workflows/release.yml'],
    ['vcs-or-ci', 'images/.gitkeep'],
    ['secret-file', '.env'],
    ['secret-file', '.env.local'],
    ['secret-file', '.npmrc'],
    ['secret-file', 'certs/server.pem'],
    ['secret-file', 'id_rsa'],
    ['tooling-config', 'tsconfig.json'],
    ['tooling-config', 'tsconfig.test.json'],
    ['tooling-config', 'eslint.config.mjs'],
    ['tooling-config', 'pnpm-lock.yaml'],
    ['tooling-config', '.releaserc.json'],
    ['editor-state', '.vscode/launch.json'],
    ['editor-state', '.DS_Store'],
    ['agent-config', '.claude/settings.json'],
    ['agent-config', '.agents/config.json'],
    ['archive', 'nestro-0.4.2.vsix'],
  ];

  it.each(forbiddenFixtures)('rejects a %s file (%s)', (forbiddenClass, packagePath) => {
    const report = evaluate({ entries: withExtraFile(packagePath) });

    expect(report.violations).toContainEqual({
      kind: 'forbidden-file',
      path: packagePath,
      detail: `forbidden class "${forbiddenClass}"`,
    });
  });

  it('covers every forbidden class with at least one fixture', () => {
    const covered = new Set(forbiddenFixtures.map(([forbiddenClass]) => forbiddenClass));
    const declared: ForbiddenClass[] = [
      'source-map',
      'cache',
      'test',
      'internal-doc',
      'source',
      'vcs-or-ci',
      'secret-file',
      'tooling-config',
      'editor-state',
      'agent-config',
      'archive',
    ];

    expect(declared.filter(forbiddenClass => !covered.has(forbiddenClass))).toEqual([]);
  });

  it('leaves every allowlisted path unclassified', () => {
    const report = evaluate();

    expect(report.packagePaths.map(classifyForbidden)).toEqual(report.packagePaths.map(() => null));
  });

  it.each([
    ['a document nobody declared', 'NOTES.md'],
    ['a stray asset directory', 'assets/logo.gif'],
    ['a screenshot with an unexpected extension', 'images/overview.jpeg'],
    ['a screenshot with an uppercase name', 'images/Overview.png'],
    ['a bundle chunk inside a subdirectory', 'out/vendor/chunk.cjs'],
  ])('rejects %s as an unexpected file (%s)', (_label, packagePath) => {
    const report = evaluate({ entries: withExtraFile(packagePath) });

    expect(report.violations).toContainEqual({
      kind: 'unexpected-file',
      path: packagePath,
      detail: 'path is not on the VSIX allowlist',
    });
  });

  it('rejects an archive entry stored outside the extension root', () => {
    const entries = [...cleanVsixArchiveEntries(), archiveEntry('leaked/secret.txt', 'x')];

    expect(evaluate({ entries }).violations).toContainEqual({
      kind: 'unexpected-file',
      path: 'leaked/secret.txt',
      detail: 'archive entry is neither vsce metadata nor extension content',
    });
  });

  it.each([
    ['[Content_Types].xml'],
    ['extension.vsixmanifest'],
  ])('reports missing vsce metadata entry %s', (metadataPath) => {
    expect(evaluate({ entries: without(metadataPath) }).violations).toContainEqual({
      kind: 'archive-metadata-missing',
      path: metadataPath,
      detail: 'vsce metadata entry is missing',
    });
  });

  it.each([
    ['LICENSE.txt', 'LICENSE'],
    ['package.nls.json', 'package.nls.json'],
  ])('reports a required package file that is missing (%s)', (packagePath, sourcePath) => {
    expect(evaluate({ entries: without(`extension/${packagePath}`) }).violations).toContainEqual({
      kind: 'missing-required-file',
      path: packagePath,
      detail: `required package file is missing (source ${sourcePath})`,
    });
  });
});

describe('evaluateVsixPolicy() — hashed bundle chunks', () => {
  it('accepts a chunk whose name carries a fresh content hash', () => {
    const entries = [
      ...without('extension/out/extension.cjs').filter(entry => entry.path !== 'extension/out/chunk-AbCdEf12.cjs'),
      archiveEntry('extension/out/extension.cjs', 'require("./lib-CsU_nP_S-BPRZRivE.cjs");'),
      archiveEntry('extension/out/lib-CsU_nP_S-BPRZRivE.cjs', 'require(\'./rolldown-runtime-C6GIJ8is-DvZhbhUT.cjs\');'),
      archiveEntry('extension/out/rolldown-runtime-C6GIJ8is-DvZhbhUT.cjs', 'module.exports = {};'),
    ];

    const report = evaluate({ entries });

    expect(report.violations).toEqual([]);
    expect(report.bundleClosure).toEqual([
      'out/extension.cjs',
      'out/lib-CsU_nP_S-BPRZRivE.cjs',
      'out/rolldown-runtime-C6GIJ8is-DvZhbhUT.cjs',
    ]);
  });

  it('rejects a chunk-shaped file that nothing requires', () => {
    const report = evaluate({ entries: withExtraFile('out/orphan-A1b2C3d4.cjs', 'module.exports = {};') });

    expect(report.violations).toContainEqual({
      kind: 'bundle-orphan-file',
      path: 'out/orphan-A1b2C3d4.cjs',
      detail: 'file in out/ is not reachable from the manifest entrypoint',
    });
  });

  it('rejects a bundle that requires a chunk which was not packaged', () => {
    const entries = replacing('extension/out/extension.cjs', 'require("./chunk-AbCdEf12.cjs");require("./missing-Zz99.cjs");');

    expect(evaluate({ entries }).violations).toContainEqual({
      kind: 'bundle-missing-chunk',
      path: 'out/missing-Zz99.cjs',
      detail: 'chunk is required by the bundle but not packaged',
    });
  });

  it.each([
    ['escapes the bundle directory', 'require("../package.json");', 'package.json'],
    ['points at a subdirectory', 'require("./vendor/chunk.cjs");', 'out/vendor/chunk.cjs'],
  ])('rejects a bundle require that %s', (_label, source, expectedPath) => {
    const entries = replacing('extension/out/extension.cjs', `${source}require("./chunk-AbCdEf12.cjs");`);

    expect(evaluate({ entries }).violations).toContainEqual({
      kind: 'bundle-invalid-path',
      path: expectedPath,
      detail: 'bundle requires a path outside the allowed chunk shape',
    });
  });

  it('reports a manifest entrypoint that is not in the package', () => {
    const entries = replacing('extension/package.json', JSON.stringify({ main: './out/absent.cjs' }));

    expect(evaluate({ entries }).violations).toContainEqual({
      kind: 'entrypoint-missing',
      path: 'out/absent.cjs',
      detail: 'manifest entrypoint is not in the package',
    });
  });

  it.each([
    ['is not valid JSON', 'not json at all', 'not valid JSON'],
    ['declares no entrypoint', JSON.stringify({ name: 'nestro' }), 'no "main" entrypoint'],
    ['points outside the bundle shape', JSON.stringify({ main: './dist/extension.js' }), 'outside the allowed bundle shape'],
  ])('reports a packaged manifest that %s', (_label, content, detail) => {
    const report = evaluate({ entries: replacing('extension/package.json', content) });

    expect(report.violations.some(violation => violation.kind === 'manifest-invalid' && violation.detail.includes(detail))).toBe(true);
    expect(report.bundleClosure).toEqual([]);
  });

  it('admits a chunk named only by a textual require — documented boundary, not a guarantee', () => {
    // resolveBundleClosure() reads chunk text, it does not parse JavaScript: a require()
    // spelled inside a comment or string literal counts as an edge. Writing into a packaged
    // chunk already means controlling the build output, so an unreferenced file still fails closed.
    const closure = resolveBundleClosure('out/extension.cjs', new Map([
      ['out/extension.cjs', '// comment mentioning require("./evil-DEADBEEF.cjs")'],
      ['out/evil-DEADBEEF.cjs', 'not javascript at all'],
    ]));

    expect(closure.closure).toEqual(['out/evil-DEADBEEF.cjs', 'out/extension.cjs']);
    expect(closure.missing).toEqual([]);
  });

  it('walks the require graph without following bare specifiers', () => {
    const closure = resolveBundleClosure('out/extension.cjs', new Map([
      ['out/extension.cjs', 'require("vscode");require("node:fs");require("./a-1234abcd.cjs");'],
      ['out/a-1234abcd.cjs', 'require("./a-1234abcd.cjs");'],
    ]));

    expect(closure).toEqual({ closure: ['out/a-1234abcd.cjs', 'out/extension.cjs'], missing: [], invalid: [] });
  });
});

describe('evaluateVsixPolicy() — symlinks', () => {
  it('rejects an archive entry stored as a symlink', () => {
    const entries = replacing('extension/images/pick-version.png', '../../etc/passwd', { isSymlink: true });

    expect(evaluate({ entries }).violations).toContainEqual({
      kind: 'symlink',
      path: 'images/pick-version.png',
      detail: 'archive entry is stored as a symlink',
    });
  });

  it.each([
    ['the packaged file itself', 'images/pick-version.png'],
    ['one of its parent directories', 'images'],
  ])('rejects a package whose content reaches through a symlink at %s', (_label, symlinkPath) => {
    expect(evaluate({ symlinkSourcePaths: [symlinkPath] }).violations).toContainEqual({
      kind: 'symlink',
      path: symlinkPath,
      detail: 'packaged path resolves through a symlink on disk',
    });
  });

  it('checks every packaged path and its ancestors for symlinks', () => {
    expect(collectSymlinkCandidates(['images/pick-version.png', 'readme.md'])).toEqual([
      'README.md',
      'images',
      'images/pick-version.png',
    ]);
  });
});

describe('evaluateVsixPolicy() — secret scan', () => {
  const secretFixtures: readonly [string, string][] = [
    ['github-token', `ghp_${'a'.repeat(36)}`],
    ['github-fine-grained-pat', `github_pat_${'B'.repeat(22)}`],
    ['npm-token', `npm_${'c'.repeat(36)}`],
    ['aws-access-key-id', `AKIA${'ABCDEFGH12345678'}`],
    ['google-api-key', `AIza${'d'.repeat(35)}`],
    ['slack-token', 'xoxb-1234567890-abcdefghij'],
    ['private-key-block', '-----BEGIN OPENSSH PRIVATE KEY-----'],
    ['json-web-token', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSM'],
    ['publishing-token-assignment', 'VSCE_PAT=abcdefghijklmnopqrstuvwxyz'],
    ['credential-assignment', 'password: "hunter2hunter2hunter2"'],
    ['credential-assignment', 'MARKETPLACE_TOKEN = "ab12cd34ef56gh78ij90"'],
    ['credential-assignment', 'AUTH_TOKEN=ab12cd34ef56gh78ij90'],
    ['credential-assignment', 'client_secret: "ab12cd34ef56gh78ij90"'],
    ['api-key-assignment', 'apikey = ab12cd34ef56gh78ij90'],
    ['api-key-assignment', 'API_KEY: "ab12cd34ef56gh78ij90"'],
  ];

  it.each(secretFixtures)('detects %s in packaged content', (id, sample) => {
    const entries = replacing('extension/readme.md', `# Nestro\n${sample}\n`);

    expect(evaluate({ entries }).violations).toContainEqual({
      kind: 'secret',
      path: 'extension/readme.md',
      detail: `matched secret pattern "${id}"`,
    });
  });

  // Ordinary code that must never fail a release: a gate that reddens falsely is a gate
  // people learn to ignore.
  it.each([
    ['a dotted member expression', 'this.tokenizer.onToken = this.tokenParser.write.bind(this)'],
    ['a token assigned from an identifier', 'const refreshToken = userSessionIdentifierValue;'],
    ['an api key assigned from an identifier', 'let apiKey = configurationDefaultsObject;'],
    ['a secret property holding an identifier', 'secret: anotherLongIdentifierName,'],
    ['a password assigned from an identifier', 'password = processEnvSomethingLongHere;'],
    ['a short quoted token', 'token: "identifier"'],
    ['a constructor name that merely contains "secrets"', 'const secretsManagerClient = new SecretsManager();'],
    ['an identifier comparison', 'passwordConfirmation === passwordConfirmationValue'],
  ])('does not flag %s', (_label, source) => {
    const entries = replacing('extension/out/chunk-AbCdEf12.cjs', `module.exports = {};\n${source}\n`);

    expect(kinds(evaluate({ entries }))).not.toContain('secret');
  });

  it('keeps scanning after an unconfirmed match, so an identifier cannot shield a real secret', () => {
    const entries = replacing(
      'extension/out/chunk-AbCdEf12.cjs',
      'const refreshToken = userSessionIdentifierValue;\nconst AUTH_TOKEN = "ab12cd34ef56gh78ij90";\n',
    );

    expect(evaluate({ entries }).violations).toContainEqual({
      kind: 'secret',
      path: 'extension/out/chunk-AbCdEf12.cjs',
      detail: 'matched secret pattern "credential-assignment"',
    });
  });

  it('exercises every declared secret pattern', () => {
    const covered = new Set(secretFixtures.map(([id]) => id));

    expect(VSIX_SECRET_PATTERNS.map(pattern => pattern.id).filter(id => !covered.has(id))).toEqual([]);
  });

  it('scans binary content instead of trusting the file extension', () => {
    const png = new Uint8Array([...toBytes('\x89PNG\r\n'), ...toBytes(`ghp_${'e'.repeat(36)}`), 0x00, 0xff]);
    const entries = replacing('extension/images/pick-version.png', png);

    expect(evaluate({ entries }).violations).toContainEqual({
      kind: 'secret',
      path: 'extension/images/pick-version.png',
      detail: 'matched secret pattern "github-token"',
    });
  });

  it('scans vsce-generated metadata as well as extension content', () => {
    const entries = replacing('extension.vsixmanifest', `<PackageManifest token="ghp_${'f'.repeat(36)}" />`);

    expect(evaluate({ entries }).violations).toContainEqual({
      kind: 'secret',
      path: 'extension.vsixmanifest',
      detail: 'matched secret pattern "github-token"',
    });
  });

  it('reports an entry whose content was not fully materialised', () => {
    const entries = replacing('extension/readme.md', '# Nestro\n', { uncompressedSize: 4096 });

    expect(evaluate({ entries }).violations).toContainEqual({
      kind: 'unscanned-file',
      path: 'extension/readme.md',
      detail: 'secret scan saw 9 of 4096 bytes',
    });
  });

  it('does not flag ordinary packaged content', () => {
    expect(kinds(evaluate())).not.toContain('secret');
  });
});

describe('evaluateVsixPolicy() — clean tracked checkout', () => {
  it('rejects a packaged file that git does not track', () => {
    const trackedSourcePaths = CLEAN_TRACKED_SOURCE_PATHS.filter(path => path !== 'images/pick-version.png');

    expect(evaluate({ trackedSourcePaths }).violations).toContainEqual({
      kind: 'untracked-file',
      path: 'images/pick-version.png',
      detail: 'packaged file is not tracked by git, so it cannot come from a clean checkout',
    });
  });

  it('exempts build output, which is never tracked', () => {
    expect(kinds(evaluate())).not.toContain('untracked-file');
  });

  it('warns, but does not fail, when a packaged file is tracked yet locally modified', () => {
    const report = evaluate({ modifiedTrackedPaths: ['README.md'] });

    expect(kinds(report)).not.toContain('modified-tracked-file');
    expect(report.warnings).toEqual([
      'README.md is tracked but modified in the working tree, so the package does not match a clean checkout',
    ]);
  });

  it('fails on a locally modified packaged file when a clean worktree is required', () => {
    const report = evaluate({ modifiedTrackedPaths: ['README.md'], requireCleanWorktree: true });

    expect(report.violations).toContainEqual({
      kind: 'modified-tracked-file',
      path: 'README.md',
      detail: 'tracked file is modified in the working tree, so verification did not use a clean checkout',
    });
    expect(report.warnings).toEqual([]);
  });

  it.each([
    'src/extension.ts',
    'tsdown.config.mts',
    'vitest.config.ts',
  ])('fails strict verification when tracked checkout input %s is modified', (sourcePath) => {
    const report = evaluate({ modifiedTrackedPaths: [sourcePath], requireCleanWorktree: true });

    expect(report.violations).toContainEqual({
      kind: 'modified-tracked-file',
      path: sourcePath,
      detail: 'tracked file is modified in the working tree, so verification did not use a clean checkout',
    });
    expect(report.warnings).toEqual([]);
  });

  it('reports a modified packaged source exactly once in strict mode', () => {
    const report = evaluate({ modifiedTrackedPaths: ['package.json'], requireCleanWorktree: true });

    expect(report.violations.filter(violation => violation.kind === 'modified-tracked-file')).toEqual([{
      kind: 'modified-tracked-file',
      path: 'package.json',
      detail: 'tracked file is modified in the working tree, so verification did not use a clean checkout',
    }]);
  });

  it('fails strict verification on an untracked build input that is not packaged directly', () => {
    const report = evaluate({
      untrackedWorktreePaths: ['src/generatedBuildInput.ts'],
      requireCleanWorktree: true,
    });

    expect(report.violations).toContainEqual({
      kind: 'untracked-worktree-file',
      path: 'src/generatedBuildInput.ts',
      detail: 'untracked file is present in the working tree, so verification did not use a clean checkout',
    });
  });

  it('does not duplicate the existing finding for an untracked file that is packaged directly', () => {
    const sourcePath = 'images/pick-version.png';
    const report = evaluate({
      trackedSourcePaths: CLEAN_TRACKED_SOURCE_PATHS.filter(path => path !== sourcePath),
      untrackedWorktreePaths: [sourcePath],
      requireCleanWorktree: true,
    });

    expect(report.violations.filter(violation => violation.path === sourcePath)).toEqual([{
      kind: 'untracked-file',
      path: sourcePath,
      detail: 'packaged file is not tracked by git, so it cannot come from a clean checkout',
    }]);
  });

  it('keeps default local verification quiet for modified files that are not packaged directly', () => {
    const report = evaluate({
      modifiedTrackedPaths: ['src/extension.ts', 'tsdown.config.mts', 'vitest.config.ts'],
      untrackedWorktreePaths: ['src/generatedBuildInput.ts'],
    });

    expect(report.violations).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('accepts strict verification when every tracked file matches HEAD', () => {
    const report = evaluate({ requireCleanWorktree: true });

    expect(report.violations).toEqual([]);
    expect(report.warnings).toEqual([]);
  });
});

describe('evaluateVsixPolicy() — budgets', () => {
  it('pins the measured clean baseline, so moving the budget is a deliberate edit', () => {
    // Pins the exact numbers rather than deriving them, so raising the underlying constant
    // is caught here as a deliberate edit instead of silently following through the budget
    // arithmetic.
    expect(CLEAN_BASELINE_COMPRESSED_BYTES).toBe(901406);
    expect(CLEAN_BASELINE_PACKAGED_FILE_COUNT).toBe(16);
    expect(COMPRESSED_SIZE_BUDGET_BYTES).toBe(1126757);
    expect(PACKAGED_FILE_COUNT_BUDGET).toBe(26);
  });

  it('derives both budgets from the measured clean baseline', () => {
    expect(COMPRESSED_SIZE_BUDGET_BYTES).toBe(Math.floor(CLEAN_BASELINE_COMPRESSED_BYTES * 1.25));
    expect(PACKAGED_FILE_COUNT_BUDGET).toBe(CLEAN_BASELINE_PACKAGED_FILE_COUNT + 10);
  });

  it('accepts a package that lands exactly on the compressed size budget', () => {
    expect(kinds(evaluate({ compressedBytes: COMPRESSED_SIZE_BUDGET_BYTES }))).not.toContain('size-budget');
  });

  it('rejects a package one byte over the compressed size budget', () => {
    const compressedBytes = COMPRESSED_SIZE_BUDGET_BYTES + 1;

    expect(evaluate({ compressedBytes }).violations).toContainEqual({
      kind: 'size-budget',
      path: '(package)',
      detail: `${compressedBytes} compressed bytes exceed the budget of ${COMPRESSED_SIZE_BUDGET_BYTES}`,
    });
  });

  it('rejects a package that carries more files than the budget allows', () => {
    const extras = Array.from(
      { length: PACKAGED_FILE_COUNT_BUDGET },
      (_unused, index) => archiveEntry(`extension/images/shot-${index}.png`, 'png'),
    );
    const entries = [...cleanVsixArchiveEntries(), ...extras];
    const expectedCount = 10 + PACKAGED_FILE_COUNT_BUDGET;

    expect(evaluate({ entries }).violations).toContainEqual({
      kind: 'file-count-budget',
      path: '(package)',
      detail: `${expectedCount} packaged files exceed the budget of ${PACKAGED_FILE_COUNT_BUDGET}`,
    });
  });
});