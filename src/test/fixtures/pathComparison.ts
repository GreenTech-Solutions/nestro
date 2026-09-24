import { realpathSync } from 'node:fs';

/**
 * Resolves a path to its canonical on-disk form so two spellings of one directory compare
 * equal: Windows reports 8.3 short names and either drive-letter case. A path that no longer
 * exists, such as a removed fixture root, is compared as given.
 */
export function canonicalizeForComparison(path: string): string {
  let resolved = path;
  try {
    resolved = realpathSync.native(path);
  }
  catch {
    // The path is already gone.
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}