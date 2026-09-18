import type { VsixArchiveEntry } from './vsixArchive';

/**
 * Content policy for the published `.vsix`: an allowlist where any unnamed path is a
 * violation. Forbidden-class rules below are a second, independent layer applying even to
 * allowlisted paths, so loosening the allowlist alone cannot re-admit a forbidden file.
 */

/** vsce stores extension content under this prefix inside the archive. */
export const VSIX_EXTENSION_PREFIX = 'extension/';

/** Archive-level files vsce generates itself. Neither comes from the repository. */
export const VSIX_ARCHIVE_METADATA_PATHS: readonly string[] = ['[Content_Types].xml', 'extension.vsixmanifest'];

export interface StaticAllowlistRule {
  /** Path inside the extension root of the archive. */
  readonly packagePath: string;
  /** Repository path the packaged file is built from — vsce renames some of them. */
  readonly sourcePath: string;
}

/**
 * Fixed single-file entries. `readme.md`, `changelog.md` and `LICENSE.txt` are
 * the names vsce writes, and their content is rewritten during packaging, which
 * is why every check below reads packaged bytes rather than repository files.
 */
export const VSIX_STATIC_ALLOWLIST: readonly StaticAllowlistRule[] = [
  { packagePath: 'package.json', sourcePath: 'package.json' },
  { packagePath: 'package.nls.json', sourcePath: 'package.nls.json' },
  { packagePath: 'readme.md', sourcePath: 'README.md' },
  { packagePath: 'changelog.md', sourcePath: 'CHANGELOG.md' },
  { packagePath: 'LICENSE.txt', sourcePath: 'LICENSE' },
  { packagePath: 'resources/icon.png', sourcePath: 'resources/icon.png' },
  { packagePath: 'resources/icon.svg', sourcePath: 'resources/icon.svg' },
];

/** README screenshots. Lowercase kebab-case `.png` only — no `.gitkeep`, no docs. */
export const VSIX_SCREENSHOT_PATTERN = /^images\/[a-z0-9]+(?:-[a-z0-9]+)*\.png$/;

/**
 * Shape guard for bundle chunks: file names carry a build-dependent content hash and cannot
 * be enumerated, so this only constrains the shape (a single `.cjs` directly inside `out/`).
 * Actual membership is decided by the require graph in `resolveBundleClosure()`.
 */
export const VSIX_BUNDLE_CHUNK_PATTERN = /^out\/[A-Za-z0-9._$@-]+\.cjs$/;

/** Packaged paths that are build output and therefore not tracked by git. */
export const VSIX_BUILD_OUTPUT_PREFIX = 'out/';

/** Measured clean-package baseline: 16 files, 901406 compressed bytes. Budget adds 25% size and 10 files. */
export const CLEAN_BASELINE_COMPRESSED_BYTES = 901406;
export const CLEAN_BASELINE_PACKAGED_FILE_COUNT = 16;
export const COMPRESSED_SIZE_BUDGET_BYTES = Math.floor(CLEAN_BASELINE_COMPRESSED_BYTES * 1.25);
export const PACKAGED_FILE_COUNT_BUDGET = CLEAN_BASELINE_PACKAGED_FILE_COUNT + 10;

export type ForbiddenClass
  = | 'source-map'
    | 'cache'
    | 'test'
    | 'internal-doc'
    | 'source'
    | 'vcs-or-ci'
    | 'secret-file'
    | 'tooling-config'
    | 'editor-state'
    | 'agent-config'
    | 'archive'
    | 'unclassified';

export interface ForbiddenRule {
  readonly forbiddenClass: ForbiddenClass;
  readonly pattern: RegExp;
}

/** Second layer: these apply to every packaged path, allowlisted or not. */
export const VSIX_FORBIDDEN_RULES: readonly ForbiddenRule[] = [
  { forbiddenClass: 'source-map', pattern: /\.map$/ },
  { forbiddenClass: 'cache', pattern: /(^|\/)(?:\.pnpm-store|node_modules|coverage|\.vscode-test|\.nyc_output|\.turbo)(\/|$)/ },
  { forbiddenClass: 'cache', pattern: /(^|\/)\.eslintcache$/ },
  { forbiddenClass: 'test', pattern: /(^|\/)(?:test|tests|__tests__|__mocks__|fixtures)(\/|$)/ },
  { forbiddenClass: 'test', pattern: /\.(?:unit\.)?(?:test|spec)\.[cm]?[jt]s$/ },
  { forbiddenClass: 'internal-doc', pattern: /(^|\/)(?:workflow|docs|scripts)(\/|$)/ },
  { forbiddenClass: 'internal-doc', pattern: /(^|\/)(?:AGENTS|CLAUDE|CODESTYLE|LEARNINGS|CONTRIBUTING|SCREENSHOTS|ARCHITECTURE|RELEASING)\.md$/i },
  { forbiddenClass: 'internal-doc', pattern: /(^|\/)vsc-extension-quickstart\.md$/i },
  { forbiddenClass: 'source', pattern: /(^|\/)src(\/|$)/ },
  { forbiddenClass: 'source', pattern: /\.[cm]?tsx?$/ },
  { forbiddenClass: 'vcs-or-ci', pattern: /(^|\/)\.(?:git|github|gitlab)(\/|$)/ },
  { forbiddenClass: 'vcs-or-ci', pattern: /(^|\/)\.git(?:ignore|keep|attributes|modules)$/ },
  { forbiddenClass: 'secret-file', pattern: /(^|\/)\.env(\.|$)/ },
  { forbiddenClass: 'secret-file', pattern: /(^|\/)\.(?:npmrc|yarnrc|netrc)$/ },
  { forbiddenClass: 'secret-file', pattern: /\.(?:pem|key|p12|pfx|jks|keystore)$/ },
  { forbiddenClass: 'secret-file', pattern: /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/ },
  { forbiddenClass: 'tooling-config', pattern: /(^|\/)tsconfig(?:\.[a-z0-9]+)*\.json$/ },
  { forbiddenClass: 'tooling-config', pattern: /(^|\/)(?:eslint|vitest|tsdown|vite|webpack)\.config\.[cm]?[jt]s$/ },
  { forbiddenClass: 'tooling-config', pattern: /(^|\/)(?:pnpm-lock\.yaml|pnpm-workspace\.yaml|package-lock\.json|yarn\.lock|bun\.lock)$/ },
  { forbiddenClass: 'tooling-config', pattern: /(^|\/)\.releaserc(?:\.[a-z]+)?$/ },
  { forbiddenClass: 'editor-state', pattern: /(^|\/)\.(?:vscode|idea|obsidian)(\/|$)/ },
  { forbiddenClass: 'editor-state', pattern: /(^|\/)\.DS_Store$/ },
  { forbiddenClass: 'agent-config', pattern: /(^|\/)\.(?:claude|agents|cursor|aider)(\/|$)/ },
  { forbiddenClass: 'archive', pattern: /\.(?:vsix|zip|tar|tgz|gz|7z|rar)$/ },
];

export interface SecretPattern {
  readonly id: string;
  readonly pattern: RegExp;
  /** Optional second-stage check applied to the matched text, kept separate from the regex for readability. */
  readonly confirm?: (match: string) => boolean;
}

/**
 * Decides whether a credential-shaped assignment carries a credential-shaped value: real
 * tokens mix in a digit or a base64 character, so a plain identifier assignment does not
 * match — a letters-only token is still caught by the `publishing-token-assignment` rule.
 */
export function looksLikeSecretValue(match: string): boolean {
  const separatorIndex = match.search(/[:=]/);
  const value = match.slice(separatorIndex + 1).replace(/^[ \t]*["']?/, '');
  return /[\d+/=]/.test(value);
}

/**
 * Credential shapes scanned over the packaged bytes of every entry (including images and
 * vsce-generated metadata) rather than repository files, since packaging rewrites README and
 * CHANGELOG. Misses opaque blobs with no recognizable prefix and any re-encoded or obfuscated token.
 */
export const VSIX_SECRET_PATTERNS: readonly SecretPattern[] = [
  { id: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { id: 'github-fine-grained-pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/ },
  { id: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
  { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'slack-token', pattern: /\bxox[abprs]-[0-9A-Za-z-]{10,}/ },
  { id: 'private-key-block', pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/ },
  { id: 'json-web-token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
  { id: 'publishing-token-assignment', pattern: /\b(?:VSCE_PAT|OVSX_PAT|AZURE_DEVOPS_EXT_PAT|NPM_TOKEN|NODE_AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN)\b[ \t]*[:=][ \t]*["']?[A-Za-z0-9+/=_-]{20,}/ },
  // Not anchored on a word boundary so a prefixed key still matches (`client_secret`,
  // `MARKETPLACE_TOKEN`); quotes around the value are optional. The value excludes `.` to
  // avoid matching dotted member-expression assignments in bundled dependencies.
  { id: 'credential-assignment', pattern: /(?:secret|token|passw(?:or)?d|credential)s?["']?[ \t]*[:=][ \t]*["']?[\w+/=-]{16,}/i, confirm: looksLikeSecretValue },
  { id: 'api-key-assignment', pattern: /api[_-]?keys?["']?[ \t]*[:=][ \t]*["']?[\w+/=-]{16,}/i, confirm: looksLikeSecretValue },
];

export type ViolationKind
  = | 'unexpected-file'
    | 'forbidden-file'
    | 'missing-required-file'
    | 'archive-metadata-missing'
    | 'symlink'
    | 'manifest-invalid'
    | 'entrypoint-missing'
    | 'bundle-missing-chunk'
    | 'bundle-orphan-file'
    | 'bundle-invalid-path'
    | 'secret'
    | 'unscanned-file'
    | 'untracked-file'
    | 'untracked-worktree-file'
    | 'modified-tracked-file'
    | 'file-count-budget'
    | 'size-budget';

export interface PolicyViolation {
  readonly kind: ViolationKind;
  readonly path: string;
  readonly detail: string;
}

export interface VsixPolicyInput {
  readonly entries: readonly VsixArchiveEntry[];
  /** Size of the `.vsix` file itself, i.e. the compressed size budget subject. */
  readonly compressedBytes: number;
  /** Output of `git ls-files`; used to reject packaged source files that are not tracked. */
  readonly trackedSourcePaths: readonly string[];
  /** Repository paths that are symlinks on disk, including ancestor directories. */
  readonly symlinkSourcePaths: readonly string[];
  /**
   * Tracked repository paths that differ from HEAD in the working tree: being tracked proves
   * the file exists in the repository, not that the packaged bytes match the committed bytes
   * (the difference between a CI checkout and a `vsce package` run from a working machine).
   */
  readonly modifiedTrackedPaths: readonly string[];
  /** Untracked, non-ignored repository paths present in the working tree. */
  readonly untrackedWorktreePaths: readonly string[];
  /**
   * When set, any tracked working-tree modification is a violation, including build inputs
   * that do not map to a packaged path. Off by default so local verification works mid-change;
   * the release pipeline enables it to require a literal clean checkout.
   */
  readonly requireCleanWorktree: boolean;
}

export interface VsixPolicyReport {
  readonly violations: readonly PolicyViolation[];
  /** Non-fatal observations. Reported on stderr, never on the manifest stream. */
  readonly warnings: readonly string[];
  /** Allowlisted paths relative to the extension root, sorted. */
  readonly packagePaths: readonly string[];
  /** Repository paths behind those packaged files, sorted. */
  readonly sourcePaths: readonly string[];
  /** Bundle files reachable from the manifest entrypoint, sorted. */
  readonly bundleClosure: readonly string[];
  readonly packagedFileCount: number;
}

interface PackagedFile {
  readonly packagePath: string;
  readonly entry: VsixArchiveEntry;
}

const RELATIVE_REQUIRE_PATTERN = /require\(\s*(["'])(\.[^"']*)\1\s*\)/g;
const LATIN1_CHUNK_SIZE = 8192;

/**
 * Deterministic code-unit ordering. `localeCompare` is deliberately avoided so
 * the emitted manifest is byte-identical regardless of the machine's locale.
 */
export function compareNormalizedPaths(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** Maps a packaged path back to the repository path it is built from. */
export function toSourcePath(packagePath: string): string {
  const rule = VSIX_STATIC_ALLOWLIST.find(candidate => candidate.packagePath === packagePath);
  return rule ? rule.sourcePath : packagePath;
}

/** Source paths plus every ancestor directory, which is what must be lstat-ed. */
export function collectSymlinkCandidates(packagePaths: readonly string[]): string[] {
  const candidates = new Set<string>();
  for (const packagePath of packagePaths) {
    const sourcePath = toSourcePath(packagePath);
    const segments = sourcePath.split('/');
    for (let index = 1; index <= segments.length; index++) {
      candidates.add(segments.slice(0, index).join('/'));
    }
  }
  return [...candidates].sort(compareNormalizedPaths);
}

/** Byte-exact decoding, so pattern matching never depends on UTF-8 validity. */
function decodeLatin1(bytes: Uint8Array): string {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += LATIN1_CHUNK_SIZE) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + LATIN1_CHUNK_SIZE));
  }
  return text;
}

export function classifyForbidden(packagePath: string): ForbiddenClass | null {
  const rule = VSIX_FORBIDDEN_RULES.find(candidate => candidate.pattern.test(packagePath));
  return rule ? rule.forbiddenClass : null;
}

function isAllowlisted(packagePath: string): boolean {
  return VSIX_STATIC_ALLOWLIST.some(rule => rule.packagePath === packagePath)
    || VSIX_SCREENSHOT_PATTERN.test(packagePath)
    || VSIX_BUNDLE_CHUNK_PATTERN.test(packagePath);
}

function normalizeRelativeRequire(fromPath: string, specifier: string): string {
  const segments = fromPath.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/**
 * Walks relative `require()` edges from the manifest entrypoint; the closure of that walk is
 * the set of bundle files allowed to ship. Reads chunk text rather than parsing JavaScript, so
 * a `require()` inside a comment or string literal is treated as a real edge.
 */
export function resolveBundleClosure(
  entrypoint: string,
  contentByPath: ReadonlyMap<string, string>,
): { closure: string[]; missing: string[]; invalid: string[] } {
  const closure = new Set<string>();
  const missing: string[] = [];
  const invalid: string[] = [];
  const queue = [entrypoint];
  closure.add(entrypoint);

  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor];
    const content = contentByPath.get(current);
    if (content === undefined) {
      missing.push(current);
      continue;
    }
    RELATIVE_REQUIRE_PATTERN.lastIndex = 0;
    let match = RELATIVE_REQUIRE_PATTERN.exec(content);
    while (match !== null) {
      const target = normalizeRelativeRequire(current, match[2]);
      if (!closure.has(target)) {
        closure.add(target);
        if (VSIX_BUNDLE_CHUNK_PATTERN.test(target)) {
          queue.push(target);
        }
        else {
          invalid.push(target);
        }
      }
      match = RELATIVE_REQUIRE_PATTERN.exec(content);
    }
  }
  const sortedClosure = [...closure].sort(compareNormalizedPaths);
  missing.sort(compareNormalizedPaths);
  invalid.sort(compareNormalizedPaths);
  return { closure: sortedClosure, missing, invalid };
}

function readManifestEntrypoint(
  packagedFiles: readonly PackagedFile[],
  violations: PolicyViolation[],
): string | null {
  const manifestFile = packagedFiles.find(file => file.packagePath === 'package.json');
  if (!manifestFile) {
    return null;
  }
  let main: unknown;
  try {
    main = (JSON.parse(decodeLatin1(manifestFile.entry.bytes)) as { main?: unknown }).main;
  }
  catch (error) {
    violations.push({
      kind: 'manifest-invalid',
      path: 'package.json',
      detail: `packaged manifest is not valid JSON: ${String(error)}`,
    });
    return null;
  }
  if (typeof main !== 'string' || main.length === 0) {
    violations.push({ kind: 'manifest-invalid', path: 'package.json', detail: 'manifest has no "main" entrypoint' });
    return null;
  }
  const entrypoint = main.replace(/^\.\//, '');
  if (!VSIX_BUNDLE_CHUNK_PATTERN.test(entrypoint)) {
    violations.push({
      kind: 'manifest-invalid',
      path: 'package.json',
      detail: `manifest "main" (${main}) is outside the allowed bundle shape`,
    });
    return null;
  }
  return entrypoint;
}

function checkArchiveShape(input: VsixPolicyInput, violations: PolicyViolation[]): PackagedFile[] {
  const packagedFiles: PackagedFile[] = [];
  const seenMetadata = new Set<string>();
  for (const entry of input.entries) {
    if (VSIX_ARCHIVE_METADATA_PATHS.includes(entry.path)) {
      seenMetadata.add(entry.path);
      continue;
    }
    if (!entry.path.startsWith(VSIX_EXTENSION_PREFIX)) {
      violations.push({
        kind: 'unexpected-file',
        path: entry.path,
        detail: 'archive entry is neither vsce metadata nor extension content',
      });
      continue;
    }
    packagedFiles.push({ packagePath: entry.path.slice(VSIX_EXTENSION_PREFIX.length), entry });
  }
  for (const metadataPath of VSIX_ARCHIVE_METADATA_PATHS) {
    if (!seenMetadata.has(metadataPath)) {
      violations.push({ kind: 'archive-metadata-missing', path: metadataPath, detail: 'vsce metadata entry is missing' });
    }
  }
  return packagedFiles;
}

function checkAllowlist(packagedFiles: readonly PackagedFile[], violations: PolicyViolation[]): void {
  for (const file of packagedFiles) {
    const forbiddenClass = classifyForbidden(file.packagePath);
    if (forbiddenClass !== null) {
      violations.push({
        kind: 'forbidden-file',
        path: file.packagePath,
        detail: `forbidden class "${forbiddenClass}"`,
      });
    }
    else if (!isAllowlisted(file.packagePath)) {
      violations.push({
        kind: 'unexpected-file',
        path: file.packagePath,
        detail: 'path is not on the VSIX allowlist',
      });
    }
  }
  const packagePaths = new Set(packagedFiles.map(file => file.packagePath));
  for (const rule of VSIX_STATIC_ALLOWLIST) {
    if (!packagePaths.has(rule.packagePath)) {
      violations.push({
        kind: 'missing-required-file',
        path: rule.packagePath,
        detail: `required package file is missing (source ${rule.sourcePath})`,
      });
    }
  }
}

function checkBundle(packagedFiles: readonly PackagedFile[], violations: PolicyViolation[]): string[] {
  const entrypoint = readManifestEntrypoint(packagedFiles, violations);
  if (entrypoint === null) {
    return [];
  }
  const bundleFiles = packagedFiles.filter(file => file.packagePath.startsWith(VSIX_BUILD_OUTPUT_PREFIX));
  const contentByPath = new Map<string, string>(
    bundleFiles.map(file => [file.packagePath, decodeLatin1(file.entry.bytes)]),
  );
  if (!contentByPath.has(entrypoint)) {
    violations.push({ kind: 'entrypoint-missing', path: entrypoint, detail: 'manifest entrypoint is not in the package' });
    return [];
  }
  const { closure, missing, invalid } = resolveBundleClosure(entrypoint, contentByPath);
  for (const path of missing) {
    violations.push({ kind: 'bundle-missing-chunk', path, detail: 'chunk is required by the bundle but not packaged' });
  }
  for (const path of invalid) {
    violations.push({ kind: 'bundle-invalid-path', path, detail: 'bundle requires a path outside the allowed chunk shape' });
  }
  const reachable = new Set(closure);
  for (const file of bundleFiles) {
    if (!reachable.has(file.packagePath)) {
      violations.push({
        kind: 'bundle-orphan-file',
        path: file.packagePath,
        detail: 'file in out/ is not reachable from the manifest entrypoint',
      });
    }
  }
  return closure.filter(path => contentByPath.has(path));
}

function checkSymlinks(
  input: VsixPolicyInput,
  packagedFiles: readonly PackagedFile[],
  violations: PolicyViolation[],
): void {
  for (const file of packagedFiles) {
    if (file.entry.isSymlink) {
      violations.push({ kind: 'symlink', path: file.packagePath, detail: 'archive entry is stored as a symlink' });
    }
  }
  const symlinks = new Set(input.symlinkSourcePaths);
  for (const sourcePath of collectSymlinkCandidates(packagedFiles.map(file => file.packagePath))) {
    if (symlinks.has(sourcePath)) {
      violations.push({ kind: 'symlink', path: sourcePath, detail: 'packaged path resolves through a symlink on disk' });
    }
  }
}

function checkTracked(
  input: VsixPolicyInput,
  packagedFiles: readonly PackagedFile[],
  violations: PolicyViolation[],
  warnings: string[],
): void {
  const tracked = new Set(input.trackedSourcePaths);
  const modified = new Set(input.modifiedTrackedPaths);
  const directlyUntracked = new Set<string>();
  if (input.requireCleanWorktree) {
    for (const sourcePath of [...modified].sort(compareNormalizedPaths)) {
      violations.push({
        kind: 'modified-tracked-file',
        path: sourcePath,
        detail: 'tracked file is modified in the working tree, so verification did not use a clean checkout',
      });
    }
  }
  for (const file of packagedFiles) {
    if (file.packagePath.startsWith(VSIX_BUILD_OUTPUT_PREFIX)) {
      continue;
    }
    const sourcePath = toSourcePath(file.packagePath);
    if (!tracked.has(sourcePath)) {
      directlyUntracked.add(sourcePath);
      violations.push({
        kind: 'untracked-file',
        path: sourcePath,
        detail: 'packaged file is not tracked by git, so it cannot come from a clean checkout',
      });
      continue;
    }
    if (input.requireCleanWorktree || !modified.has(sourcePath)) {
      continue;
    }
    warnings.push(
      `${sourcePath} is tracked but modified in the working tree, `
      + 'so the package does not match a clean checkout',
    );
  }
  if (input.requireCleanWorktree) {
    const untracked = new Set(input.untrackedWorktreePaths);
    for (const sourcePath of [...untracked].sort(compareNormalizedPaths)) {
      if (directlyUntracked.has(sourcePath)) {
        continue;
      }
      violations.push({
        kind: 'untracked-worktree-file',
        path: sourcePath,
        detail: 'untracked file is present in the working tree, so verification did not use a clean checkout',
      });
    }
  }
}

function hasConfirmedSecretMatch(secret: SecretPattern, content: string): boolean {
  const flags = `${secret.pattern.flags.replace('g', '')}g`;
  const pattern = new RegExp(secret.pattern.source, flags);
  for (const match of content.matchAll(pattern)) {
    if (secret.confirm === undefined || secret.confirm(match[0])) {
      return true;
    }
  }
  return false;
}

/** Scans every archive entry, including binaries; a short read is reported instead of silently skipped. */
function checkSecrets(input: VsixPolicyInput, violations: PolicyViolation[]): void {
  for (const entry of input.entries) {
    if (entry.bytes.length !== entry.uncompressedSize) {
      violations.push({
        kind: 'unscanned-file',
        path: entry.path,
        detail: `secret scan saw ${entry.bytes.length} of ${entry.uncompressedSize} bytes`,
      });
    }
    const content = decodeLatin1(entry.bytes);
    for (const secret of VSIX_SECRET_PATTERNS) {
      if (!hasConfirmedSecretMatch(secret, content)) {
        continue;
      }
      violations.push({ kind: 'secret', path: entry.path, detail: `matched secret pattern "${secret.id}"` });
    }
  }
}

function checkBudgets(input: VsixPolicyInput, packagedFileCount: number, violations: PolicyViolation[]): void {
  if (packagedFileCount > PACKAGED_FILE_COUNT_BUDGET) {
    violations.push({
      kind: 'file-count-budget',
      path: '(package)',
      detail: `${packagedFileCount} packaged files exceed the budget of ${PACKAGED_FILE_COUNT_BUDGET}`,
    });
  }
  if (input.compressedBytes > COMPRESSED_SIZE_BUDGET_BYTES) {
    violations.push({
      kind: 'size-budget',
      path: '(package)',
      detail: `${input.compressedBytes} compressed bytes exceed the budget of ${COMPRESSED_SIZE_BUDGET_BYTES}`,
    });
  }
}

/** Runs every layer of the policy and returns all violations, never just the first. */
export function evaluateVsixPolicy(input: VsixPolicyInput): VsixPolicyReport {
  const violations: PolicyViolation[] = [];
  const warnings: string[] = [];
  const packagedFiles = checkArchiveShape(input, violations);
  checkAllowlist(packagedFiles, violations);
  const bundleClosure = checkBundle(packagedFiles, violations);
  checkSymlinks(input, packagedFiles, violations);
  checkTracked(input, packagedFiles, violations, warnings);
  checkSecrets(input, violations);
  checkBudgets(input, packagedFiles.length, violations);

  const packagePaths = packagedFiles.map(file => file.packagePath).sort(compareNormalizedPaths);
  const sourcePaths = packagePaths.map(toSourcePath).sort(compareNormalizedPaths);
  return {
    violations,
    warnings,
    packagePaths,
    sourcePaths,
    bundleClosure,
    packagedFileCount: packagedFiles.length,
  };
}