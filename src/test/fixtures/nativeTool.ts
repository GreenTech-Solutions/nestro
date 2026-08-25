import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const TEMP_DIR_PREFIX = 'nestro-native-tool-';

/** Bounds a real CLI invocation, including a first-run Corepack download. */
const NATIVE_TOOL_TIMEOUT_MS = 60000;

export interface NativeToolProbe {
  readonly available: boolean;
  readonly output?: string;
  readonly reason?: string;
}

/**
 * Spawns a native package-manager binary directly, deliberately bypassing the VS Code Task
 * API and `ClientManager` (which stay hermetic argv-only), to prove the real `bun`/`yarn`
 * binary is present and runnable. Any failure returns `available: false` instead of throwing,
 * so callers can skip the dependent test gracefully.
 */
export async function probeNativeTool(
  command: string,
  args: readonly string[],
  cwd?: string,
): Promise<NativeToolProbe> {
  try {
    const { stdout } = await execFileAsync(command, [...args], { cwd, timeout: NATIVE_TOOL_TIMEOUT_MS });
    return { available: true, output: stdout.toString().trim() };
  }
  catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export interface PinnedManagerDir {
  readonly dir: string;
}

/**
 * A temp directory whose `package.json` pins `packageManager` — the signal Corepack reads to
 * run a specific Yarn release regardless of PATH. Must live outside the repository: this repo's
 * own `packageManager` (pinned to pnpm) makes Corepack refuse to run `yarn` inside the working tree.
 */
export async function createPinnedManagerDir(packageManager: string): Promise<PinnedManagerDir> {
  const dir = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
  const manifest = {
    name: 'nestro-native-smoke',
    version: '1.0.0',
    private: true,
    packageManager,
  };
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8');
  return { dir };
}

/** Deletes the temporary directory created by {@link createPinnedManagerDir}. */
export async function removePinnedManagerDir(pinned: PinnedManagerDir): Promise<void> {
  await rm(pinned.dir, { recursive: true, force: true });
}