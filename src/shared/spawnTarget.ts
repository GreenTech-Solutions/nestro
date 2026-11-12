import { statSync } from 'node:fs';
import { win32 as winPath } from 'node:path';

/** A command line ready for `spawn()` / `execFile()`. */
export interface ResolvedSpawnTarget {
  kind: 'resolved';
  command: string;
  args: string[];
  /** Set when `args` form a pre-quoted `cmd.exe` command line that must reach the child untouched. */
  windowsVerbatimArguments?: true;
}

/** The command cannot be launched safely; nothing was spawned. */
export interface UnresolvedSpawnTarget {
  kind: 'unresolved';
  reason: 'command-not-found' | 'process-failed';
  message: string;
}

export type SpawnTarget = ResolvedSpawnTarget | UnresolvedSpawnTarget;

/** Platform inputs of {@link resolveSpawnTarget}; overridable so the Windows branch is testable anywhere. */
export interface SpawnTargetEnvironment {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  isFile: (filePath: string) => boolean;
}

/** Windows launcher extensions, in lookup order within one PATH directory. */
const WINDOWS_LAUNCHER_EXTENSIONS = ['.exe', '.cmd'] as const;

/**
 * Every character a `cmd.exe` argument may contain. It excludes whitespace, quotes, `%`, `!`,
 * `^` and all command separators/redirections, so an accepted argument needs no escaping.
 */
const WINDOWS_SAFE_ARGUMENT = /^[A-Za-z0-9_.:@/+~-]+$/;

/** A launcher path is placed inside double quotes, where only `%` and `!` can still expand. */
const WINDOWS_UNSAFE_LAUNCHER_PATH = /["%!\u0000-\u001F]/;

/**
 * Resolves what to spawn for a package-manager (or any bare) command. On Windows `npm`, `pnpm`
 * and `yarn` are `.cmd` shims that `spawn()` cannot start, and a `.cmd`/`.bat` started without a
 * shell fails with EINVAL; the shim is therefore located on `PATH` (never in the working
 * directory) and hosted by the system `cmd.exe`. Elsewhere, and for real `.exe` binaries, the
 * command is returned unchanged.
 */
export function resolveSpawnTarget(
  command: string,
  args: readonly string[],
  environment: Partial<SpawnTargetEnvironment> = {},
): SpawnTarget {
  const { platform = process.platform, env = process.env, isFile = isRegularFile } = environment;
  if (platform !== 'win32') {
    return { kind: 'resolved', command, args: [...args] };
  }

  const launcher = findWindowsLauncher(command, env, isFile);
  if (launcher === undefined) {
    return { kind: 'unresolved', reason: 'command-not-found', message: `${command} was not found on PATH.` };
  }
  if (launcher.toLowerCase().endsWith('.exe')) {
    return { kind: 'resolved', command: launcher, args: [...args] };
  }

  if (WINDOWS_UNSAFE_LAUNCHER_PATH.test(launcher)) {
    return {
      kind: 'unresolved',
      reason: 'process-failed',
      message: `${command} resolves to a path that cmd.exe cannot start safely.`,
    };
  }
  const unsafeIndex = args.findIndex(arg => !WINDOWS_SAFE_ARGUMENT.test(arg));
  if (unsafeIndex >= 0) {
    return {
      kind: 'unresolved',
      reason: 'process-failed',
      message: `Argument ${unsafeIndex + 1} contains characters cmd.exe cannot receive safely.`,
    };
  }

  // `/s` strips only the outer quote pair, so the quoted launcher path inside survives intact.
  const commandLine = [`"${launcher}"`, ...args].join(' ');
  return {
    kind: 'resolved',
    command: getWindowsSystemExecutablePath('cmd.exe', readEnv(env, 'SystemRoot')),
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

function findWindowsLauncher(
  command: string,
  env: NodeJS.ProcessEnv,
  isFile: (filePath: string) => boolean,
): string | undefined {
  const isAbsolute = winPath.isAbsolute(command);
  if (!isAbsolute && /[\\/]/.test(command)) {
    return undefined;
  }
  const directories = isAbsolute
    ? [winPath.dirname(command)]
    : (readEnv(env, 'PATH') ?? '').split(';')
        .map(entry => entry.trim().replace(/^"(.*)"$/, '$1'))
        .filter(entry => winPath.isAbsolute(entry));
  const fileName = winPath.basename(command);
  const hasExtension = WINDOWS_LAUNCHER_EXTENSIONS.some(ext => fileName.toLowerCase().endsWith(ext));
  const names = hasExtension ? [fileName] : WINDOWS_LAUNCHER_EXTENSIONS.map(ext => fileName + ext);

  for (const directory of directories) {
    for (const name of names) {
      const candidate = winPath.join(directory, name);
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** Case-insensitive lookup: plain objects (unlike `process.env` on Windows) do not fold key case. */
function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

function isRegularFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  }
  catch {
    return false;
  }
}

/**
 * Resolves a Windows system executable without consulting PATH. A malformed or relative
 * environment value cannot redirect the runner through the workspace; only an absolute
 * `SystemRoot` is accepted, with the standard Windows root as fallback.
 */
export function getWindowsSystemExecutablePath(fileName: string, systemRoot: string | undefined): string {
  const root = isCanonicalLocalWindowsRoot(systemRoot)
    ? systemRoot
    : 'C:\\Windows';
  return winPath.join(root, 'System32', fileName);
}

/**
 * This is a syntactic boundary only, not proof that the caller owns the directory: accept
 * a normalized, drive-qualified local Windows path and reject namespace/root-relative,
 * traversal, malformed and control-character forms before composing the fixed suffix.
 */
function isCanonicalLocalWindowsRoot(systemRoot: string | undefined): systemRoot is string {
  if (typeof systemRoot !== 'string'
    || systemRoot.length === 0
    || systemRoot !== systemRoot.trim()
    || !/^[A-Za-z]:[\\/]/.test(systemRoot)
    || /[\u0000-\u001F\u007F"<>|?*]/.test(systemRoot)
    || systemRoot.slice(2).includes(':')
    || systemRoot.split(/[\\/]/).some(segment => segment === '.' || segment === '..')) {
    return false;
  }
  const canonicalCandidate = systemRoot.replace(/\//g, '\\');
  return winPath.normalize(canonicalCandidate) === canonicalCandidate;
}