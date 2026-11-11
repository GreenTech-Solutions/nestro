import * as path from 'node:path';

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

/** Normalizes a CLI directory argument and requires a safe relative subdirectory of the repository. */
export function normalizeArtifactOutDir(outDir: string): string {
  if (outDir.length === 0
    || CONTROL_CHARACTER_PATTERN.test(outDir)
    || path.posix.isAbsolute(outDir)
    || path.win32.isAbsolute(outDir)
    || /^[A-Za-z]:/u.test(outDir)) {
    throw new Error('VSIX --out-dir must be a safe relative subdirectory of the repository');
  }
  const portablePath = outDir.replaceAll('\\', '/');
  if (portablePath.split('/').includes('..')) {
    throw new Error('VSIX --out-dir must be a safe relative subdirectory of the repository');
  }
  let normalized = path.posix.normalize(portablePath);
  while (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized === '.' || normalized.startsWith('../')) {
    throw new Error('VSIX --out-dir must be a safe relative subdirectory of the repository');
  }
  return normalized;
}