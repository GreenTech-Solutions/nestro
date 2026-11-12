import * as path from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import { hasErrorCode, isPathWithin } from '../shared';

interface ExistingArtifactAncestor {
  readonly lexicalPath: string;
  readonly realPath: string;
}

async function resolveExistingAncestor(candidatePath: string): Promise<ExistingArtifactAncestor> {
  let current = candidatePath;
  while (true) {
    try {
      return { lexicalPath: current, realPath: await realpath(current) };
    }
    catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }
      current = parent;
    }
  }
}

function assertArtifactDirectoryContained(
  repositoryPath: string,
  candidatePath: string,
  dirPath: string,
  allowRepositoryRoot: boolean,
): void {
  if (!isPathWithin(repositoryPath, candidatePath)) {
    throw new Error(`VSIX output directory ${dirPath} resolves outside the repository`);
  }
  if (!allowRepositoryRoot && path.relative(repositoryPath, candidatePath) === '') {
    throw new Error(`VSIX output directory ${dirPath} must resolve to a proper subdirectory of the repository`);
  }
}

function assertArtifactDirectoryNotAliased(
  lexicalRepositoryPath: string,
  canonicalRepositoryPath: string,
  lexicalCandidatePath: string,
  canonicalCandidatePath: string,
  dirPath: string,
): void {
  const expectedCanonicalPath = path.resolve(
    canonicalRepositoryPath,
    path.relative(lexicalRepositoryPath, lexicalCandidatePath),
  );
  if (path.relative(expectedCanonicalPath, canonicalCandidatePath) !== '') {
    throw new Error(`VSIX output directory ${dirPath} must not resolve through a symlink alias below the repository`);
  }
}

/** Creates `dirPath` under `cwd` and proves, before and after creating it, that its real path stays inside the repository. */
export async function prepareArtifactDirectory(cwd: string, dirPath: string): Promise<void> {
  const lexicalRepositoryPath = path.resolve(cwd);
  const repositoryPath = await realpath(cwd);
  const requestedPath = path.resolve(cwd, dirPath);
  const existingAncestor = await resolveExistingAncestor(requestedPath);
  assertArtifactDirectoryContained(
    repositoryPath,
    existingAncestor.realPath,
    dirPath,
    existingAncestor.lexicalPath !== requestedPath,
  );
  assertArtifactDirectoryNotAliased(
    lexicalRepositoryPath,
    repositoryPath,
    existingAncestor.lexicalPath,
    existingAncestor.realPath,
    dirPath,
  );
  await mkdir(requestedPath, { recursive: true });
  const preparedPath = await realpath(requestedPath);
  assertArtifactDirectoryContained(repositoryPath, preparedPath, dirPath, false);
  assertArtifactDirectoryNotAliased(
    lexicalRepositoryPath,
    repositoryPath,
    requestedPath,
    preparedPath,
    dirPath,
  );
}