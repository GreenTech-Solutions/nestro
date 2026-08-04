import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkspaceFixture } from './types';

const TEMP_ROOT_PREFIX = 'nestro-fixture-';

export interface MaterializedFixture {
  readonly fixture: WorkspaceFixture;
  /** Absolute, symlink-resolved root of this copy of the fixture. */
  readonly rootPath: string;
  /** Absolute paths of the fixture roots, in declaration order. */
  readonly folderPaths: readonly string[];
}

/** Absolute, symlink-resolved system temp directory holding every fixture copy. */
export async function fixtureTempRoot(): Promise<string> {
  return await realpath(tmpdir());
}

/**
 * Copies a fixture into a brand new temporary directory. Every call gets its own
 * root, so two tests using the same fixture never touch the same files, and the
 * repository working tree is never written to.
 *
 * The temp root is resolved through `realpath` because macOS exposes
 * `os.tmpdir()` behind the `/var` -> `/private/var` symlink while VS Code
 * reports workspace folder paths verbatim; comparing the two forms otherwise
 * fails.
 */
export async function materializeFixture(fixture: WorkspaceFixture): Promise<MaterializedFixture> {
  const rootPath = await realpath(await mkdtemp(join(tmpdir(), TEMP_ROOT_PREFIX)));

  for (const [relativePath, contents] of Object.entries(fixture.files)) {
    const target = resolveFixturePath(rootPath, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }

  return {
    fixture,
    rootPath,
    folderPaths: fixture.roots.map(root => resolveFixturePath(rootPath, root.path)),
  };
}

/** Deletes the temporary copy created by {@link materializeFixture}. */
export async function removeMaterializedFixture(materialized: MaterializedFixture): Promise<void> {
  await rm(materialized.rootPath, { recursive: true, force: true });
}

/** Resolves a POSIX-style fixture-relative path against a materialized root. */
export function resolveFixturePath(rootPath: string, relativePath: string): string {
  return join(rootPath, ...relativePath.split('/'));
}