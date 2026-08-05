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
 * Spawns a native package-manager binary directly — not through the VS Code
 * Task API, which `Shell Task Lifecycle` (AUD-02C) already covers, and not
 * through `ClientManager`/`Client.buildUpdateCommand()`, which stay hermetic
 * argv-only elsewhere in this file. This is the deliberately non-hermetic
 * half of AUD-02D (plan decision 18/23): it proves the actual `bun`/`yarn`
 * binaries `Client` subclasses would shell out to are genuinely present and
 * runnable in this environment.
 *
 * Any failure — the binary is missing (`ENOENT`), or present but unable to
 * complete (e.g. a Corepack version resolution failing without network) —
 * comes back as `available: false` rather than throwing, so callers can skip
 * the dependent test gracefully instead of failing a machine that simply
 * does not have the tool.
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
 * A temp directory whose `package.json` pins `packageManager` — the exact
 * signal Corepack reads to transparently run a specific Yarn release,
 * independent of whatever `yarn` happens to resolve to on PATH. Must live
 * outside the repository: this repo's own `packageManager` field (pinned to
 * pnpm) makes Corepack refuse to run `yarn` at all from inside the working
 * tree (verified manually — `yarn --version` from the repo root prints
 * "This project is configured to use pnpm...").
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