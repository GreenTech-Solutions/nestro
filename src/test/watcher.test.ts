import * as assert from 'assert';
import * as vscode from 'vscode';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { registerWorkspaceFoldersWatcher } from '../extension';
import { FilterManager, PackagesProvider } from '../providers';
import {
  closeFixtureWorkspace,
  closeIfOpen,
  collectPackageItems,
  createPackageJsonWatcherHarness,
  createStubContext,
  DEBOUNCE_SETTLE_MS,
  delay,
  disposeStubContext,
  ensureExtensionActivated,
  NATIVE_WATCHER_ATTACH_TIMEOUT_MS,
  openTrackedFixture,
  removeFixturePath,
  SINGLE_ROOT_FIXTURES,
  SUPPRESSION_SETTLE_MS,
  waitUntil,
  writeUntil,
} from './fixtures';
import type { OpenedFixtureWorkspace, PackageJsonWatcherHarness } from './fixtures';

suite('Package.json Watcher (real Extension Host)', function () {
  // The warm-up may retry for most of the attach ceiling, which exceeds Mocha's
  // 20s default, so raise the budget for every test and hook here.
  this.timeout(NATIVE_WATCHER_ATTACH_TIMEOUT_MS + 15000);

  const fixture = SINGLE_ROOT_FIXTURES[0];
  let opened: OpenedFixtureWorkspace | undefined;
  let folderPath: string;
  let rootPackageJsonPath: string;
  let activeHarnesses: PackageJsonWatcherHarness[] = [];

  suiteSetup(async function () {
    this.timeout(NATIVE_WATCHER_ATTACH_TIMEOUT_MS + 5000);

    await ensureExtensionActivated();
    opened = await openTrackedFixture(fixture);
    folderPath = opened.folders[0].uri.fsPath;
    rootPackageJsonPath = join(folderPath, 'package.json');

    // Pay the backend's one-time first-attach cost here rather than inside
    // whichever test happens to run first.
    const warmUp = createPackageJsonWatcherHarness();
    try {
      await warmUpWatcher(warmUp);
    }
    finally {
      warmUp.dispose();
    }
  });

  suiteTeardown(async () => {
    await closeIfOpen(opened);
    opened = undefined;
  });

  teardown(() => {
    activeHarnesses.forEach(harness => harness.dispose());
    activeHarnesses = [];
  });

  /**
   * Rewrites a sentinel manifest until the backend proves it is attached, then
   * removes it and returns the settled load count as a baseline. A single write
   * would not do: issued before the backend attaches, its event never happens
   * at all, leaving nothing to wait for.
   */
  async function warmUpWatcher(harness: PackageJsonWatcherHarness): Promise<number> {
    const sentinelDir = join(folderPath, 'watcher-warmup');
    const before = harness.loadCount();

    try {
      await mkdir(sentinelDir, { recursive: true });
      await writeUntil(
        join(sentinelDir, 'package.json'),
        attempt => `{"name":"watcher-warmup","attempt":${attempt}}\n`,
        () => harness.loadCount() > before,
        NATIVE_WATCHER_ATTACH_TIMEOUT_MS,
        'the package.json watcher to become live',
      );
    }
    finally {
      await removeFixturePath(sentinelDir);
    }

    await delay(DEBOUNCE_SETTLE_MS);
    return harness.loadCount();
  }

  async function startHarness(): Promise<{ harness: PackageJsonWatcherHarness; baseline: number }> {
    const harness = createPackageJsonWatcherHarness();
    activeHarnesses.push(harness);
    return { harness, baseline: await warmUpWatcher(harness) };
  }

  async function expectSingleReload(harness: PackageJsonWatcherHarness, baseline: number, what: string): Promise<void> {
    await waitUntil(() => Promise.resolve(harness.loadCount() === baseline + 1), `exactly one reload after ${what}`);
    await delay(DEBOUNCE_SETTLE_MS);
    assert.strictEqual(harness.loadCount(), baseline + 1, `${what} must not cause more than one reload`);
  }

  test('creating a package.json under the workspace triggers exactly one reload', async () => {
    const { harness, baseline } = await startHarness();
    const nestedDir = join(folderPath, 'nested-create');

    try {
      await mkdir(nestedDir, { recursive: true });
      await writeFile(join(nestedDir, 'package.json'), '{"name":"nested-create","version":"1.0.0"}\n', 'utf8');
      await expectSingleReload(harness, baseline, 'creating package.json');
    }
    finally {
      await removeFixturePath(nestedDir);
    }
  });

  test('changing package.json triggers exactly one reload', async () => {
    const { harness, baseline } = await startHarness();
    const original = await readFile(rootPackageJsonPath, 'utf8');

    try {
      await writeFile(rootPackageJsonPath, original.replace('"1.0.0"', '"1.0.1"'), 'utf8');
      await expectSingleReload(harness, baseline, 'changing package.json');
    }
    finally {
      await writeFile(rootPackageJsonPath, original, 'utf8');
    }
  });

  test('deleting package.json triggers exactly one reload', async () => {
    const nestedDir = join(folderPath, 'nested-delete');
    const nestedPath = join(nestedDir, 'package.json');
    await mkdir(nestedDir, { recursive: true });
    await writeFile(nestedPath, '{"name":"nested-delete","version":"1.0.0"}\n', 'utf8');

    const { harness, baseline } = await startHarness();

    try {
      // Only the file: removing the directory recursively can coalesce into a
      // single event for the directory path, which the glob never matches.
      await removeFixturePath(nestedPath);
      await expectSingleReload(harness, baseline, 'deleting package.json');
    }
    finally {
      await removeFixturePath(nestedDir);
    }
  });

  test('a burst of rapid events inside the debounce window coalesces into one reload', async () => {
    const { harness, baseline } = await startHarness();
    const original = await readFile(rootPackageJsonPath, 'utf8');

    try {
      for (let i = 0; i < 3; i += 1) {
        await writeFile(rootPackageJsonPath, original.replace('"1.0.0"', `"1.0.${i}"`), 'utf8');
        // Well inside the 500ms window, so the timer keeps resetting.
        await delay(80);
      }
      await expectSingleReload(harness, baseline, 'a burst of rapid writes');
    }
    finally {
      await writeFile(rootPackageJsonPath, original, 'utf8');
    }
  });

  test('events are ignored while provider writes are suppressed', async () => {
    const { harness, baseline } = await startHarness();
    const original = await readFile(rootPackageJsonPath, 'utf8');

    try {
      await harness.provider.withWriteSuppressed(async () => {
        await writeFile(rootPackageJsonPath, original.replace('"1.0.0"', '"1.0.2"'), 'utf8');
      });

      await delay(SUPPRESSION_SETTLE_MS);
      assert.strictEqual(harness.loadCount(), baseline, 'suppressed writes must not trigger a reload');

      // The zero above has to be suppression, not a dead watcher.
      await writeFile(rootPackageJsonPath, original.replace('"1.0.0"', '"1.0.3"'), 'utf8');
      await waitUntil(
        () => Promise.resolve(harness.loadCount() === baseline + 1),
        'a reload once suppression has lifted',
      );
    }
    finally {
      await writeFile(rootPackageJsonPath, original, 'utf8');
    }
  });

  test('dispose cancels a pending debounce and stops future reloads', async () => {
    const { harness, baseline } = await startHarness();
    const original = await readFile(rootPackageJsonPath, 'utf8');

    try {
      await writeFile(rootPackageJsonPath, original.replace('"1.0.0"', '"1.0.4"'), 'utf8');
      // Dispose inside the 500ms window, while the reload is still pending.
      await delay(150);
      harness.controller.dispose();

      await delay(DEBOUNCE_SETTLE_MS);
      assert.strictEqual(harness.loadCount(), baseline, 'a reload pending at dispose time must be cancelled');

      await writeFile(rootPackageJsonPath, original.replace('"1.0.0"', '"1.0.5"'), 'utf8');
      await delay(DEBOUNCE_SETTLE_MS);
      assert.strictEqual(harness.loadCount(), baseline, 'events after dispose must not be observed');
    }
    finally {
      await writeFile(rootPackageJsonPath, original, 'utf8');
    }
  });
});

suite('Workspace Folder Change (real Extension Host)', () => {
  test('adding then removing a workspace folder loads and clears its packages', async () => {
    const provider = new PackagesProvider(new FilterManager('all'));
    const context = createStubContext();
    let refreshCount = 0;
    registerWorkspaceFoldersWatcher(
      context as unknown as vscode.ExtensionContext,
      provider,
      () => { refreshCount += 1; },
    );

    try {
      const openedFolder = await openTrackedFixture(SINGLE_ROOT_FIXTURES[2]);
      try {
        await waitUntil(
          () => Promise.resolve(collectPackageItems(provider).some(item => item.packageName === 'left-pad')),
          'workspace packages to appear after adding a folder',
        );
        assert.strictEqual(refreshCount, 1, 'adding a folder must refresh the package.json watcher');
      }
      finally {
        await closeFixtureWorkspace(openedFolder);
      }

      await waitUntil(
        () => Promise.resolve(collectPackageItems(provider).length === 0),
        'workspace packages to disappear after removing a folder',
      );
      assert.strictEqual(refreshCount, 2, 'removing a folder must refresh the package.json watcher');
    }
    finally {
      provider.dispose();
      disposeStubContext(context);
    }
  });
});