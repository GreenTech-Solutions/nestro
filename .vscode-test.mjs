import { defineConfig } from '@vscode/test-cli';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const rootDir = dirname(fileURLToPath(import.meta.url));

/**
 * Short digest of this checkout's absolute path.
 *
 * The generated workspace lives in the system temp directory, which is shared by
 * every checkout on the machine. Without a discriminator two clones running
 * their suites at the same time would delete and rewrite each other's workspace
 * file. This does not make concurrent runs of the *same* checkout safe: loading
 * this config resets the channel directories, so a second run — including the
 * `--list-configuration` the VS Code Extension Test Runner issues — still
 * disturbs a live one.
 */
const CHECKOUT_ID = createHash('sha256').update(rootDir).digest('hex').slice(0, 8);

/**
 * Lowest VS Code version the extension claims to support.
 * Must stay an exact patch and match `engines.vscode` / `@types/vscode`.
 */
const MINIMUM_VSCODE_VERSION = '1.125.0';

/** Glob handed to Mocha, relative to this file. */
const COMPILED_TESTS_GLOB = 'out/test/**/*.test.js';

/** Directory the glob above resolves into. */
const COMPILED_TESTS_DIR = join(rootDir, 'out', 'test');

/**
 * VS Code names its IPC socket `<version.substr(0, 4)>-main.sock` inside the
 * user-data dir, e.g. `1.12-main.sock` for 1.125.0. The version slice is always
 * four characters, so the file name length is constant across channels.
 */
const SOCKET_FILE_NAME_LENGTH = '1.12-main.sock'.length;

/**
 * `sun_path` budget per platform, mirroring VS Code's own table. VS Code warns
 * at `length >= limit`; on macOS the kernel then hard-fails with `EINVAL` one
 * character later. Windows uses a named pipe, so no limit applies there.
 */
const SOCKET_PATH_LIMITS = { darwin: 103, linux: 107 };

/**
 * Fails the configuration when no compiled integration test exists.
 *
 * Mocha reports `0 passing` with exit code 0 when it finds no test file, and
 * `pnpm run build` wipes `out/` (tsdown `clean: true`) together with
 * `out/test/`. Without this check a channel could report success without having
 * executed a single test.
 */
function assertCompiledTestsExist() {
  if (countCompiledTests(COMPILED_TESTS_DIR) > 0) {
    return;
  }

  throw new Error(
    `No compiled integration tests found under ${COMPILED_TESTS_DIR} (glob "${COMPILED_TESTS_GLOB}"). `
    + 'Run `pnpm run test:compile` first — `pnpm run build` removes `out/` including the compiled tests, '
    + 'and a run with zero tests would otherwise report success.',
  );
}

function countCompiledTests(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  }
  catch {
    return 0;
  }

  let count = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      count += countCompiledTests(join(directory, entry.name));
    }
    else if (entry.name.endsWith('.test.js')) {
      count += 1;
    }
  }
  return count;
}

/**
 * Fails the configuration as soon as the extension declares dependent
 * extensions or a channel asks for extra ones.
 *
 * `@vscode/test-cli` installs those through `installDependentExtensions()`
 * (`out/cli/platform/desktop.mjs`), which calls `downloadAndUnzipVSCode()`
 * without `cachePath` and `resolveCliArgsFromVSCodeExecutablePath()` without the
 * channel `launchArgs`. The extensions would land in the shared
 * `.vscode-test/extensions` and `.vscode-test/user-data` directories that the
 * channel run never reads, silently voiding this file's isolation. Breaking
 * loudly is preferable to losing isolation without a trace.
 */
function assertNoDependentExtensions(label, channel) {
  const manifest = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
  const declared = [
    ...(manifest.extensionDependencies ?? []),
    ...(manifest.extensionPack ?? []),
    ...(channel.installExtensions ?? []),
  ];

  if (declared.length === 0) {
    return;
  }

  throw new Error(
    `Channel "${label}" would install dependent extensions (${declared.join(', ')}), which @vscode/test-cli `
    + 'downloads and installs without this channel\'s cachePath / user-data-dir / extensions-dir. They would go '
    + 'to the shared .vscode-test/extensions and .vscode-test/user-data instead, so the channel would run '
    + 'without them and channel isolation would be lost. Install them into the channel directories explicitly '
    + 'before allowing extensionDependencies, extensionPack or installExtensions.',
  );
}

/**
 * Fails the configuration when the projected IPC socket path does not fit into
 * the platform `sun_path` limit, instead of letting Electron surface an opaque
 * `listen EINVAL` from deep inside the VS Code bootstrap.
 *
 * The threshold is VS Code's own warning condition (`length >= limit`), which is
 * one character below the point where macOS actually rejects the bind. Failing
 * at the warning threshold keeps the check conservative and its message
 * actionable.
 *
 * The check is deliberately pessimistic on Linux: when `XDG_RUNTIME_DIR` is set
 * VS Code puts the socket there instead of in the user-data dir, so the measured
 * path is not the one that gets used. With a 107-character budget and short CI
 * paths that never triggers, and over-reporting is preferable to missing the
 * case where the variable is absent.
 */
function assertSocketPathFits(label, userDataDir) {
  const limit = SOCKET_PATH_LIMITS[process.platform];
  if (limit === undefined) {
    return;
  }

  // `<userDataDir>/<version>-main.sock`
  const projectedLength = userDataDir.length + 1 + SOCKET_FILE_NAME_LENGTH;
  if (projectedLength < limit) {
    return;
  }

  throw new Error(
    `Channel "${label}" would open its IPC socket at a ${projectedLength}-character path inside ${userDataDir}. `
    + `On ${process.platform} VS Code warns from ${limit} characters and the kernel then rejects the bind with an `
    + `opaque EINVAL from ${limit + 1}. Move the repository to a shorter path or shorten the channel user-data `
    + 'directory name.',
  );
}

/**
 * Resets a channel to a pristine user profile.
 *
 * VS Code persists window state inside the user-data dir and restores it on the
 * next launch. A previous run that left an untitled workspace behind therefore
 * makes the next launch open extra windows, each of which loads the development
 * extension and runs `extensionTestsPath` again — several copies of the suite
 * executing concurrently against different workspaces. Wiping the profile per
 * run removes that whole class of cross-run bleed; `window.restoreWindows` is
 * seeded as a second line of defence for state created mid-run.
 *
 * Only the user-data dir is reset. The download cache next to it holds the
 * unpacked VS Code build and must survive.
 */
function resetChannelUserData(userDataDir) {
  rmSync(userDataDir, { recursive: true, force: true });

  const userDir = join(userDataDir, 'User');
  mkdirSync(userDir, { recursive: true });
  writeFileSync(
    join(userDir, 'settings.json'),
    `${JSON.stringify({ 'window.restoreWindows': 'none' }, undefined, 2)}\n`,
    'utf8',
  );
}

/**
 * Creates the workspace the Extension Host opens for a channel.
 *
 * The suite must never open the repository itself: doing so feeds the real
 * extension manifest into the tests and lets any test write to the working
 * tree. Instead every channel opens a generated `.code-workspace` file in the
 * system temp directory holding a single empty anchor folder. Tests then add
 * and remove their own fixture folders after that anchor.
 *
 * A workspace file rather than a plain folder is required for two reasons.
 * Adding a folder to a plain single-folder workspace materializes an untitled
 * workspace inside the user-data dir, which outlives the run; and changing the
 * folder at index 0 restarts the Extension Host, which restarts the whole test
 * file. The anchor folder keeps index 0 fixed and the workspace file keeps the
 * profile free of untitled workspaces.
 */
function createChannelWorkspaceFile(label) {
  // `realpathSync` because macOS exposes `os.tmpdir()` behind the
  // `/var` -> `/private/var` symlink and VS Code reports workspace folder paths
  // exactly as they were given; the tests compare both forms.
  const workspaceDir = join(realpathSync(tmpdir()), 'nestro-vscode-test', `${CHECKOUT_ID}-${label}`);
  const anchorDir = join(workspaceDir, 'anchor');

  rmSync(workspaceDir, { recursive: true, force: true });
  mkdirSync(anchorDir, { recursive: true });

  const workspaceFile = join(workspaceDir, `nestro-${label}.code-workspace`);
  const contents = {
    folders: [{ path: 'anchor' }],
    settings: {
      // Both already default to false in the manifest, so activation is offline
      // either way. Pinning them here keeps a machine-level user setting from
      // turning a test run into a registry or audit call.
      'nestro.checkUpdatesOnStartup': false,
      'nestro.runAuditOnStartup': false,
    },
  };
  writeFileSync(workspaceFile, `${JSON.stringify(contents, undefined, 2)}\n`, 'utf8');

  return workspaceFile;
}

/**
 * Builds one Extension Host channel.
 *
 * Every channel owns a `.vscode-test/<label>/` subtree with its own download
 * cache, extensions dir and user-data dir, so no state is shared between the
 * channels or leaks across runs. `--user-data-dir` / `--extensions-dir` must be
 * passed explicitly: `@vscode/test-electron` otherwise falls back to the shared
 * `.vscode-test/user-data` and `.vscode-test/extensions` defaults regardless of
 * `cachePath`.
 *
 * The user-data dir is named `ud` rather than `user-data` on purpose. VS Code
 * opens a `<major>.<minor>-main.sock` Unix domain socket inside it, and the
 * absolute socket path must stay within the ~103-character `sun_path` limit on
 * macOS and Linux. The extra `<label>/` level already costs those characters,
 * so the leaf is kept short to preserve headroom for deep project paths;
 * `assertSocketPathFits()` turns an overrun into a readable error.
 *
 * @param {string} label Channel name, also used as the `--label` CLI selector.
 * @param {string} version Exact VS Code version, or the `stable` quality tag.
 */
function defineChannel(label, version) {
  const channelDir = join(rootDir, '.vscode-test', label);
  const cachePath = join(channelDir, 'cache');
  const extensionsDir = join(channelDir, 'extensions');
  const userDataDir = join(channelDir, 'ud');

  // `@vscode/test-electron` creates the cache dir non-recursively, so the
  // channel subtree has to exist before the first download starts.
  mkdirSync(cachePath, { recursive: true });
  assertSocketPathFits(label, userDataDir);
  resetChannelUserData(userDataDir);

  const channel = {
    label,
    version,
    files: COMPILED_TESTS_GLOB,
    workspaceFolder: createChannelWorkspaceFile(label),
    cachePath,
    launchArgs: [`--user-data-dir=${userDataDir}`, `--extensions-dir=${extensionsDir}`],
    mocha: {
      ui: 'tdd',
      timeout: 20000,
      // A run that executes no test must be red, not a silent success.
      failZero: true,
    },
  };

  assertNoDependentExtensions(label, channel);

  return channel;
}

assertCompiledTestsExist();

export default defineConfig([
  defineChannel('minimum', MINIMUM_VSCODE_VERSION),
  defineChannel('stable', 'stable'),
]);