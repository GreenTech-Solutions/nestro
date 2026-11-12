import { runChildProcess } from './childProcess';

/**
 * Parses `git status --porcelain -z --untracked-files=no` into tracked paths that differ from
 * HEAD. Untracked entries (`??`) are skipped — collected separately by `listUntrackedFiles()` —
 * and a rename/copy record's extra NUL-separated source-path field is consumed and ignored.
 */
export function parseGitStatusPaths(stdout: string): string[] {
  const fields = stdout.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (field.length < 4) {
      continue;
    }
    const status = field.slice(0, 2);
    if (status !== '??') {
      paths.push(field.slice(3));
    }
    if (status.startsWith('R') || status.startsWith('C')) {
      index++;
    }
  }
  return paths;
}

function splitNulSeparated(stdout: string): string[] {
  return stdout.split('\0').filter(entry => entry.length > 0);
}

/** `git ls-files`: every tracked path of the checkout. */
export async function listTrackedFiles(cwd: string): Promise<string[]> {
  return splitNulSeparated(await runChildProcess('git', ['ls-files', '-z'], cwd, 'git ls-files'));
}

/** Tracked paths whose working-tree content differs from HEAD. */
export async function listModifiedTrackedFiles(cwd: string): Promise<string[]> {
  const stdout = await runChildProcess('git', ['status', '--porcelain', '-z', '--untracked-files=no'], cwd, 'git status');
  return parseGitStatusPaths(stdout);
}

/** Untracked paths that are not ignored. */
export async function listUntrackedFiles(cwd: string): Promise<string[]> {
  const stdout = await runChildProcess('git', ['ls-files', '--others', '--exclude-standard', '-z'], cwd, 'git ls-files --others');
  return splitNulSeparated(stdout);
}