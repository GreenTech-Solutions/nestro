import { compareCodeUnits, describeError, sha256Hex } from '../shared';

const MANIFEST_LINE_PATTERN = /^([0-9a-f]{64}) {2}([^\r\n]+)$/u;

export interface NormalizedManifestEntry {
  readonly path: string;
  readonly sha256: string;
}

/** `<sha256>  <archive path>` per entry, ordered by path so the manifest is comparable across builds. */
function buildNormalizedManifestLines(entries: readonly { path: string; bytes: Uint8Array }[]): string[] {
  return [...entries]
    .sort((left, right) => compareCodeUnits(left.path, right.path))
    .map(entry => `${sha256Hex(entry.bytes)}  ${entry.path}`);
}

export function buildNormalizedManifest(entries: readonly { path: string; bytes: Uint8Array }[]): string {
  return `${buildNormalizedManifestLines(entries).join('\n')}\n`;
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
  const sorted = [...entries].sort((left, right) => compareCodeUnits(left.path, right.path));
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
    return describeError(error);
  }
  const expected = parseNormalizedManifest(buildNormalizedManifest(entries));
  return JSON.stringify(parsed) === JSON.stringify(expected)
    ? undefined
    : 'normalized manifest does not match the candidate archive contents';
}