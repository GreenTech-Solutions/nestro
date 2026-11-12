import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

/** True for an error that carries the given errno `code`, such as `ENOENT`. */
export function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

/** The UTF-8 contents of the file, or undefined when it does not exist; every other failure throws. */
export async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  }
  catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
}

/** True when `candidatePath` is `rootPath` itself or lies beneath it, judged lexically on the host platform. */
export function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}