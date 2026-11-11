import { decodeLatin1 } from './vsixArchive';
import type { PackagedFile, PolicyViolation } from './vsixPolicyTypes';
import { VSIX_BUILD_OUTPUT_PREFIX, VSIX_BUNDLE_CHUNK_PATTERN } from './vsixRules';
import { compareCodeUnits } from '../shared';

const RELATIVE_REQUIRE_PATTERN = /require\(\s*(["'])(\.[^"']*)\1\s*\)/g;

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
  const sortedClosure = [...closure].sort(compareCodeUnits);
  missing.sort(compareCodeUnits);
  invalid.sort(compareCodeUnits);
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

/** Checks the bundle against the manifest entrypoint's require graph; returns the packaged closure. */
export function checkBundle(packagedFiles: readonly PackagedFile[], violations: PolicyViolation[]): string[] {
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