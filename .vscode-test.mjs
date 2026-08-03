import { defineConfig } from '@vscode/test-cli';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const rootDir = dirname(fileURLToPath(import.meta.url));

/**
 * Lowest VS Code version the extension claims to support.
 * Must stay an exact patch and match `engines.vscode` / `@types/vscode`.
 */
const MINIMUM_VSCODE_VERSION = '1.125.0';

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
 * so the leaf is kept short to preserve headroom for deep project paths.
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

  return {
    label,
    version,
    files: 'out/test/**/*.test.js',
    workspaceFolder: '.',
    cachePath,
    launchArgs: [`--user-data-dir=${userDataDir}`, `--extensions-dir=${extensionsDir}`],
    mocha: {
      ui: 'tdd',
      timeout: 20000,
    },
  };
}

export default defineConfig([
  defineChannel('minimum', MINIMUM_VSCODE_VERSION),
  defineChannel('stable', 'stable'),
]);
