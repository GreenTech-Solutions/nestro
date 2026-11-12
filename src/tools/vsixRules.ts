import { compareCodeUnits } from '../shared';

/**
 * Path rules for the published `.vsix`: an allowlist where any unnamed path is a violation.
 * Forbidden-class rules below are a second, independent layer applying even to allowlisted
 * paths, so loosening the allowlist alone cannot re-admit a forbidden file.
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
  return [...candidates].sort(compareCodeUnits);
}

export function classifyForbidden(packagePath: string): ForbiddenClass | null {
  const rule = VSIX_FORBIDDEN_RULES.find(candidate => candidate.pattern.test(packagePath));
  return rule ? rule.forbiddenClass : null;
}

export function isAllowlisted(packagePath: string): boolean {
  return VSIX_STATIC_ALLOWLIST.some(rule => rule.packagePath === packagePath)
    || VSIX_SCREENSHOT_PATTERN.test(packagePath)
    || VSIX_BUNDLE_CHUNK_PATTERN.test(packagePath);
}