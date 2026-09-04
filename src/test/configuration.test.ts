import * as assert from 'assert';
import * as vscode from 'vscode';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { registerConfigurationWatcher } from '../extension';
import { FilterManager, PackagesProvider } from '../providers';
import {
  closeIfOpen,
  createPackageJsonWatcherHarness,
  createStubContext,
  DEBOUNCE_SETTLE_MS,
  delay,
  disposeStubContext,
  ensureExtensionActivated,
  NATIVE_WATCHER_ATTACH_TIMEOUT_MS,
  onceTreeChanged,
  openTrackedFixture,
  setNestroConfigValue,
  SINGLE_ROOT_FIXTURES,
  waitUntil,
  writeUntil,
} from './fixtures';
import type { OpenedFixtureWorkspace, StubExtensionContext } from './fixtures';

/**
 * `registerConfigurationWatcher` owns no timers, so this window is enough to
 * tell "there is no listener branch for this key" from "it has not fired yet".
 */
const NO_REFRESH_WINDOW_MS = 300;

/** Keys `registerConfigurationWatcher` reacts to, besides `monorepoGlob`. */
const WIRED_KEYS: readonly { readonly key: string; readonly value: unknown; readonly verify?: (filter: FilterManager) => void }[] = [
  { key: 'defaultFilter', value: 'patch', verify: filter => assert.strictEqual(filter.current, 'patch') },
  { key: 'updateTarget', value: 'minor' },
  { key: 'includePreReleases', value: true },
  { key: 'minimumReleaseAgeDays', value: 14 },
];

/**
 * The remaining runtime-relevant settings are read at activate() time or lazily
 * by a command handler, so changing them must not refresh the tree.
 */
const UNWIRED_KEYS: readonly { readonly key: string; readonly value: unknown }[] = [
  { key: 'checkUpdatesOnStartup', value: true },
  { key: 'deferInstallAfterUpdate', value: true },
  { key: 'confirmBulkUpdate', value: false },
  { key: 'runAuditOnStartup', value: true },
  { key: 'checkUpdatesDebounce', value: 5 },
  { key: 'checkUpdatesForceAlways', value: true },
];

suite('Configuration Watcher (real Extension Host)', () => {
  let provider: PackagesProvider;
  let filterManager: FilterManager;
  let context: StubExtensionContext;

  setup(() => {
    filterManager = new FilterManager('all');
    provider = new PackagesProvider(filterManager);
    context = createStubContext();
    registerConfigurationWatcher(context as unknown as vscode.ExtensionContext, provider);
  });

  teardown(() => {
    disposeStubContext(context);
    provider.dispose();
  });

  for (const { key, value, verify } of WIRED_KEYS) {
    test(`changing nestro.${key} refreshes the tree`, async () => {
      let changed = false;
      const disposable = provider.onDidChangeTreeData(() => { changed = true; });
      const revert = await setNestroConfigValue(key, value);
      try {
        await waitUntil(() => Promise.resolve(changed), `nestro.${key} to refresh the tree`);
        assert.strictEqual(changed, true, `nestro.${key} must refresh the tree`);
        verify?.(filterManager);
      }
      finally {
        disposable.dispose();
        await revert();
      }
    });
  }

  for (const { key, value } of UNWIRED_KEYS) {
    test(`changing nestro.${key} does not refresh the tree`, async () => {
      let changed = false;
      const disposable = provider.onDidChangeTreeData(() => { changed = true; });
      const revert = await setNestroConfigValue(key, value);
      try {
        await delay(NO_REFRESH_WINDOW_MS);
        assert.strictEqual(changed, false, `nestro.${key} is not wired to registerConfigurationWatcher`);
      }
      finally {
        disposable.dispose();
        await revert();
      }
    });
  }
});

suite('Configuration Watcher — monorepoGlob recreates the package.json watcher', function () {
  // Two fresh watchers are created here, either of which can pay the native
  // backend's first-attach cost.
  this.timeout(NATIVE_WATCHER_ATTACH_TIMEOUT_MS + 15000);

  const fixture = SINGLE_ROOT_FIXTURES[1];
  let opened: OpenedFixtureWorkspace | undefined;
  let folderPath: string;

  suiteSetup(async () => {
    await ensureExtensionActivated();
    opened = await openTrackedFixture(fixture);
    folderPath = opened.folders[0].uri.fsPath;
  });

  suiteTeardown(async () => {
    await closeIfOpen(opened);
    opened = undefined;
  });

  test('changing nestro.monorepoGlob rebuilds the watchers and events still arrive', async () => {
    const harness = createPackageJsonWatcherHarness();
    const configContext = createStubContext();
    registerConfigurationWatcher(
      configContext as unknown as vscode.ExtensionContext,
      harness.provider,
      () => harness.controller.refresh(),
    );

    const rootPackageJsonPath = join(folderPath, 'package.json');
    const scopedDir = join(folderPath, 'glob-scope');

    try {
      // The watcher is recreated synchronously before loadPackages(), which
      // fires onDidChangeTreeData first thing — so this event proves the
      // rebuild already happened rather than guessing at timing.
      const rebuilt = onceTreeChanged(harness.provider);
      const revert = await setNestroConfigValue('monorepoGlob', 'glob-scope/*.json');
      try {
        await rebuilt;
        const baseline = harness.loadCount();
        const original = await readFile(rootPackageJsonPath, 'utf8');

        try {
          await writeFile(rootPackageJsonPath, original.replace('"1.0.0"', '"1.0.1"'), 'utf8');
          await delay(DEBOUNCE_SETTLE_MS);
          assert.strictEqual(
            harness.loadCount(),
            baseline,
            'a path excluded by the new glob must not trigger a reload',
          );
        }
        finally {
          await writeFile(rootPackageJsonPath, original, 'utf8');
        }

        // A matching file still gets picked up, proving the recreated watcher
        // is live rather than merely quiet. Retried, because the rebuilt
        // watcher attaches its backend asynchronously too.
        await mkdir(scopedDir, { recursive: true });
        await writeUntil(
          join(scopedDir, 'package.json'),
          attempt => `{"name":"glob-scope","attempt":${attempt}}\n`,
          () => harness.loadCount() === baseline + 1,
          NATIVE_WATCHER_ATTACH_TIMEOUT_MS,
          'a reload after a file matching the new glob is created',
        );
      }
      finally {
        await revert();
      }
    }
    finally {
      await rm(scopedDir, { recursive: true, force: true });
      disposeStubContext(configContext);
      harness.dispose();
    }
  });
});