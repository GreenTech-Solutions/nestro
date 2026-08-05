import * as assert from 'assert';
import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { ClientManager } from '../clients';
import { FilterManager, GroupItem, PackageItem, PackagesProvider } from '../providers';
import { runShellTaskAndWait } from '../utils';
import {
  awaitTaskOutcome,
  buildExitWithCodeCommand,
  buildSleepCommand,
  closeFixtureWorkspace,
  countWorkspaceFolders,
  createNoProcessTask,
  createScriptFixture,
  fixtureTempRoot,
  materializeFixture,
  MULTI_ROOT_FIXTURES,
  openFixtureWorkspace,
  recordedExtensionHosts,
  recordExtensionHost,
  removeMaterializedFixture,
  removeScriptFixture,
  resolveFixturePath,
  ROOT_MANIFEST_NESTED_PACKAGE,
  SINGLE_ROOT_FIXTURES,
  waitUntil,
} from './fixtures';
import type { OpenedFixtureWorkspace, ScriptFixture, WorkspaceFixture } from './fixtures';
import type { PackageStateIdentity } from '../providers';

const EXTENSION_ID = 'greentech-solutions.nestro';

/**
 * Folders present before any fixture is opened: the single empty anchor folder
 * of the generated `.code-workspace` file (see `.vscode-test.mjs`).
 */
const ANCHOR_FOLDER_COUNT = 1;

// A workspace-folder change that restarts the Extension Host would invalidate
// every assumption this suite makes about shared module state, and a restarted
// host silently re-runs the whole file. Recording the process on disk at load
// time is what makes that observable: an in-process copy of `process.pid` is
// re-initialized by the restart it is supposed to detect.
recordExtensionHost();

/** Every fixture root opened during the run, checked for leaks at the end. */
const openedFixtureRoots: string[] = [];

function requireExtension(): vscode.Extension<unknown> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, 'Extension should be registered');
  return extension;
}

function isInside(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath);
}

function toPosixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join('/');
}

async function openTrackedFixture(fixture: WorkspaceFixture): Promise<OpenedFixtureWorkspace> {
  const opened = await openFixtureWorkspace(fixture);
  openedFixtureRoots.push(opened.rootPath);
  return opened;
}

/**
 * Closes a fixture opened in `suiteSetup`. A failed setup leaves the handle
 * undefined, and an unguarded teardown would then fail with a type error that
 * hides the original failure.
 */
async function closeIfOpen(opened: OpenedFixtureWorkspace | undefined): Promise<void> {
  if (opened !== undefined) {
    await closeFixtureWorkspace(opened);
  }
}

function requireOpen(opened: OpenedFixtureWorkspace | undefined): OpenedFixtureWorkspace {
  assert.ok(opened, 'Fixture workspace should have been opened in suiteSetup');
  return opened;
}

async function findManifests(folder: vscode.WorkspaceFolder): Promise<string[]> {
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, '**/package.json'),
    '**/node_modules/**',
  );
  return uris
    .map(uri => toPosixRelative(folder.uri.fsPath, uri.fsPath))
    .sort((left, right) => left.localeCompare(right));
}

async function waitForManifests(
  folder: vscode.WorkspaceFolder,
  expected: readonly string[],
): Promise<string[]> {
  let found: string[] = [];
  await waitUntil(
    async () => {
      found = await findManifests(folder);
      return found.length === expected.length;
    },
    `${expected.length} manifest(s) under workspace folder ${folder.uri.fsPath}`,
  );
  return found;
}

suite('Extension Test Suite', () => {
  let extension: vscode.Extension<unknown>;

  suiteSetup(async () => {
    extension = requireExtension();
    await extension.activate();
  });

  test('Extension activates successfully', () => {
    assert.strictEqual(extension.isActive, true);
  });

  test('nestro.refresh command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('nestro.refresh'), 'Refresh command should be registered');
  });

  test('nestro.installUpdate command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('nestro.installUpdate'), 'Update command should be registered');
  });

  test('nestro.pickVersion command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('nestro.pickVersion'), 'Pick version command should be registered');
  });

  test('nestro.runInstall command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('nestro.runInstall'), 'Run install command should be registered');
  });

  test('nestro.updateAllVisible command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('nestro.updateAllVisible'), 'Update all command should be registered');
  });

  test('nestro.runAudit command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('nestro.runAudit'), 'Run audit command should be registered');
  });

  test('nestro.removePackage command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('nestro.removePackage'), 'Remove package command should be registered');
  });
});

suite('Workspace Isolation', () => {
  test('Extension Host does not open the repository root', () => {
    const repositoryRoot = requireExtension().extensionPath;
    const folders = vscode.workspace.workspaceFolders ?? [];

    assert.ok(folders.length > 0, 'Test workspace should expose at least the anchor folder');
    for (const folder of folders) {
      assert.notStrictEqual(folder.uri.fsPath, repositoryRoot, 'Repository root must not be a workspace folder');
      assert.strictEqual(
        isInside(repositoryRoot, folder.uri.fsPath),
        false,
        `Workspace folder ${folder.uri.fsPath} must live outside the repository`,
      );
    }
  });

  test('Baseline workspace holds only the temporary anchor folder', async () => {
    const tempRoot = await fixtureTempRoot();
    const folders = vscode.workspace.workspaceFolders ?? [];

    assert.strictEqual(folders.length, ANCHOR_FOLDER_COUNT);
    assert.strictEqual(
      isInside(tempRoot, folders[0].uri.fsPath),
      true,
      `Anchor folder ${folders[0].uri.fsPath} should live under ${tempRoot}`,
    );
  });

  test('Baseline workspace exposes no package manifest', async () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    assert.deepStrictEqual(await findManifests(folders[0]), []);
  });
});

suite('Fixture Materialization', () => {
  const fixture = SINGLE_ROOT_FIXTURES[0];

  test('Materializing a fixture writes its whole tree into a temporary root', async () => {
    const tempRoot = await fixtureTempRoot();
    const materialized = await materializeFixture(fixture);

    try {
      assert.strictEqual(isInside(tempRoot, materialized.rootPath), true);
      for (const relativePath of Object.keys(fixture.files)) {
        assert.strictEqual(
          existsSync(resolveFixturePath(materialized.rootPath, relativePath)),
          true,
          `${relativePath} should exist in the materialized fixture`,
        );
      }
      assert.strictEqual(
        existsSync(resolveFixturePath(materialized.rootPath, 'node_modules')),
        false,
        'Fixtures must stay metadata-only',
      );
    }
    finally {
      await removeMaterializedFixture(materialized);
    }

    assert.strictEqual(existsSync(materialized.rootPath), false, 'Cleanup should remove the temporary root');
  });

  test('Two copies of one fixture never share a root', async () => {
    const first = await materializeFixture(fixture);
    const second = await materializeFixture(fixture);

    try {
      assert.notStrictEqual(first.rootPath, second.rootPath);
      await removeMaterializedFixture(first);
      assert.strictEqual(existsSync(first.rootPath), false);
      assert.strictEqual(existsSync(second.rootPath), true, 'Removing one copy must not touch the other');
    }
    finally {
      await removeMaterializedFixture(first);
      await removeMaterializedFixture(second);
    }
  });

  test('Closing a fixture workspace restores the baseline', async () => {
    const opened = await openTrackedFixture(fixture);
    assert.strictEqual(countWorkspaceFolders(), ANCHOR_FOLDER_COUNT + fixture.roots.length);

    await closeFixtureWorkspace(opened);

    assert.strictEqual(countWorkspaceFolders(), ANCHOR_FOLDER_COUNT);
    assert.strictEqual(existsSync(opened.rootPath), false);
    assert.strictEqual(
      vscode.workspace.getWorkspaceFolder(vscode.Uri.file(opened.folderPaths[0])),
      undefined,
      'Removed fixture folder must no longer resolve to a workspace folder',
    );
  });
});

for (const fixture of SINGLE_ROOT_FIXTURES) {
  suite(`Single-root fixture: ${fixture.id}`, () => {
    let opened: OpenedFixtureWorkspace | undefined;

    suiteSetup(async () => {
      opened = await openTrackedFixture(fixture);
    });

    suiteTeardown(async () => {
      await closeIfOpen(opened);
      opened = undefined;
    });

    test('Adds exactly one workspace folder outside the repository', () => {
      const repositoryRoot = requireExtension().extensionPath;
      const folders = requireOpen(opened).folders;

      assert.strictEqual(countWorkspaceFolders(), ANCHOR_FOLDER_COUNT + 1);
      assert.strictEqual(folders.length, 1);
      assert.strictEqual(isInside(repositoryRoot, folders[0].uri.fsPath), false);
    });

    test('Detects the package manager of the fixture', async () => {
      const folder = requireOpen(opened).folders[0];
      const detected = await new ClientManager().detectPackageManager(folder.uri.fsPath);
      assert.strictEqual(detected, fixture.roots[0].manager);
    });

    test('Discovers the fixture manifests', async () => {
      const folder = requireOpen(opened).folders[0];
      const found = await waitForManifests(folder, fixture.roots[0].manifests);
      assert.deepStrictEqual(found, [...fixture.roots[0].manifests]);
    });
  });
}

for (const fixture of MULTI_ROOT_FIXTURES) {
  suite(`Multi-root fixture: ${fixture.id}`, () => {
    let opened: OpenedFixtureWorkspace | undefined;

    suiteSetup(async () => {
      opened = await openTrackedFixture(fixture);
    });

    suiteTeardown(async () => {
      await closeIfOpen(opened);
      opened = undefined;
    });

    test('Adds every fixture root as a distinct workspace folder', () => {
      const repositoryRoot = requireExtension().extensionPath;
      const paths = requireOpen(opened).folders.map(folder => folder.uri.fsPath);

      assert.strictEqual(countWorkspaceFolders(), ANCHOR_FOLDER_COUNT + fixture.roots.length);
      assert.strictEqual(new Set(paths).size, fixture.roots.length);
      for (const folderPath of paths) {
        assert.strictEqual(isInside(repositoryRoot, folderPath), false);
      }
    });

    test('Detects the package manager of every root independently', async () => {
      const clientManager = new ClientManager();
      const detected: string[] = [];
      for (const folder of requireOpen(opened).folders) {
        detected.push(await clientManager.detectPackageManager(folder.uri.fsPath));
      }
      assert.deepStrictEqual(detected, fixture.roots.map(root => root.manager));
    });

    test('Discovers the manifests of every root', async () => {
      for (const [index, folder] of requireOpen(opened).folders.entries()) {
        const expected = fixture.roots[index].manifests;
        assert.deepStrictEqual(await waitForManifests(folder, expected), [...expected]);
      }
    });
  });
}

suite('Multi-root fixture details', () => {
  test('Same-basename roots stay distinct folders with their own manager', async () => {
    const fixture = MULTI_ROOT_FIXTURES.find(candidate => candidate.id === 'multi-root-same-basename');
    assert.ok(fixture, 'Same-basename fixture should exist');

    const opened = await openTrackedFixture(fixture);
    try {
      const basenames = opened.folders.map(folder => folder.uri.fsPath.split(sep).at(-1));
      assert.deepStrictEqual(basenames, ['app', 'app'], 'Both roots should share a basename');

      const clientManager = new ClientManager();
      assert.strictEqual(await clientManager.detectPackageManager(opened.folders[0].uri.fsPath), 'npm');
      assert.strictEqual(await clientManager.detectPackageManager(opened.folders[1].uri.fsPath), 'pnpm');
    }
    finally {
      await closeFixtureWorkspace(opened);
    }
  });

  test('Nested package inherits the manager of its root manifest', async () => {
    const fixture = MULTI_ROOT_FIXTURES.find(candidate => candidate.id === 'multi-root-root-manifest');
    assert.ok(fixture, 'Root-manifest fixture should exist');

    const opened = await openTrackedFixture(fixture);
    try {
      const nested = resolveFixturePath(opened.folders[0].uri.fsPath, ROOT_MANIFEST_NESTED_PACKAGE);
      assert.strictEqual(existsSync(nested), true);
      assert.strictEqual(await new ClientManager().detectPackageManager(nested), 'pnpm');
    }
    finally {
      await closeFixtureWorkspace(opened);
    }
  });
});

suite('Shell Task Lifecycle', function () {
  this.timeout(30000);

  let scripts: ScriptFixture;
  let taskCounter = 0;

  suiteSetup(async () => {
    scripts = await createScriptFixture();
  });

  suiteTeardown(async () => {
    await removeScriptFixture(scripts);
  });

  function nextTaskName(label: string): string {
    taskCounter += 1;
    return `Nestro Test - ${label} #${taskCounter}`;
  }

  test('resolves with the process exit code on a successful task', async () => {
    const exitCode = await runShellTaskAndWait(buildExitWithCodeCommand(scripts, 0), nextTaskName('Success'));
    assert.strictEqual(exitCode, 0);
  });

  test('resolves with the exact non-zero exit code on a failing task', async () => {
    const exitCode = await runShellTaskAndWait(buildExitWithCodeCommand(scripts, 7), nextTaskName('Failure'));
    assert.strictEqual(exitCode, 7);
  });

  test('listeners do not leak: a task run after a success resolves independently', async () => {
    const first = await runShellTaskAndWait(buildExitWithCodeCommand(scripts, 0), nextTaskName('Success'));
    assert.strictEqual(first, 0);

    const second = await runShellTaskAndWait(buildExitWithCodeCommand(scripts, 3), nextTaskName('Success-Rerun'));
    assert.strictEqual(second, 3, 'A task started after a successful run must resolve on its own outcome');
  });

  test('listeners do not leak: a task run after a failure resolves independently', async () => {
    const first = await runShellTaskAndWait(buildExitWithCodeCommand(scripts, 5), nextTaskName('Failure'));
    assert.strictEqual(first, 5);

    const second = await runShellTaskAndWait(buildExitWithCodeCommand(scripts, 0), nextTaskName('Failure-Rerun'));
    assert.strictEqual(second, 0, 'A task started after a failing run must resolve on its own outcome');
  });

  test('resolves with undefined and does not hang for a task that reports no exit code', async () => {
    const taskName = nextTaskName('NoExitCode');
    const outcome = await awaitTaskOutcome(createNoProcessTask(taskName));
    assert.strictEqual(
      outcome,
      undefined,
      'A task that never reports a numeric exit code must resolve as undefined instead of hanging, '
      + 'matching the shellTask.ts:62-73 fallback',
    );

    const rerun = await runShellTaskAndWait(buildExitWithCodeCommand(scripts, 0), nextTaskName('NoExitCode-Rerun'));
    assert.strictEqual(rerun, 0, 'A task started afterwards must not be intercepted by the earlier run\'s listeners');
  });

  test('resolves without hanging when the user terminates the task, and later tasks are unaffected', async () => {
    const taskName = nextTaskName('Terminate');
    const outcomePromise = runShellTaskAndWait(buildSleepCommand(scripts), taskName);

    await waitUntil(
      () => Promise.resolve(vscode.tasks.taskExecutions.some(execution => execution.task.name === taskName)),
      `task "${taskName}" to appear in vscode.tasks.taskExecutions`,
    );
    const execution = vscode.tasks.taskExecutions.find(candidate => candidate.task.name === taskName);
    assert.ok(execution, 'The running task should be discoverable through vscode.tasks.taskExecutions');
    execution.terminate();

    const outcome = await outcomePromise;
    assert.strictEqual(
      outcome,
      undefined,
      'A terminated task resolves through the same exit contract as a task with no reported exit code',
    );

    const rerun = await runShellTaskAndWait(buildExitWithCodeCommand(scripts, 0), nextTaskName('Terminate-Rerun'));
    assert.strictEqual(rerun, 0, 'A task started after a termination must not be intercepted by the terminated run\'s listeners');
  });
});

suite('Shell Task Lifecycle: package update busy state', function () {
  this.timeout(30000);

  const fixture = SINGLE_ROOT_FIXTURES[0];
  let opened: OpenedFixtureWorkspace | undefined;
  let scripts: ScriptFixture;
  let filterManager: FilterManager;
  let provider: PackagesProvider;

  suiteSetup(async () => {
    scripts = await createScriptFixture();
    opened = await openTrackedFixture(fixture);
    filterManager = new FilterManager();
    provider = new PackagesProvider(filterManager);
    await provider.loadPackages();
  });

  suiteTeardown(async () => {
    provider.dispose();
    filterManager.dispose();
    await closeIfOpen(opened);
    opened = undefined;
    await removeScriptFixture(scripts);
  });

  function findPackageItem(name: string): PackageItem | undefined {
    const groups = provider.getChildren().filter((item): item is GroupItem => item instanceof GroupItem);
    const items = groups.flatMap(group => group.children).filter((item): item is PackageItem => item instanceof PackageItem);
    return items.find(item => item.packageName === name);
  }

  function identityFor(item: PackageItem): PackageStateIdentity {
    return {
      packageName: item.packageName,
      packageFilePath: item.packageFilePath,
      section: item.dev ? 'devDependencies' : 'dependencies',
    };
  }

  test('clears busy state and applies the new version after a successful task', async () => {
    const before = findPackageItem('left-pad');
    assert.ok(before, 'left-pad should be present after loadPackages()');
    assert.strictEqual(before.installing, false);

    const identity = identityFor(before);
    provider.markPackageUpdating(identity, true);
    assert.strictEqual(findPackageItem('left-pad')?.installing, true, 'Item should be marked installing while the task runs');

    const exitCode = await runShellTaskAndWait(buildExitWithCodeCommand(scripts, 0), 'Test Update left-pad');
    assert.strictEqual(exitCode, 0);

    provider.invalidateUpdateCache();
    provider.markPackageUpdated(identity, '9.9.9');

    const after = findPackageItem('left-pad');
    assert.ok(after);
    assert.strictEqual(after.installing, false, 'Busy state must clear once the task exits successfully');
    assert.strictEqual(after.currentVersion, `${before.versionPrefix}9.9.9`);
  });

  test('clears busy state without applying the update after a failing task', async () => {
    const before = findPackageItem('rimraf');
    assert.ok(before, 'rimraf should be present after loadPackages()');
    const originalVersion = before.currentVersion;

    const identity = identityFor(before);
    provider.markPackageUpdating(identity, true);
    assert.strictEqual(findPackageItem('rimraf')?.installing, true, 'Item should be marked installing while the task runs');

    const exitCode = await runShellTaskAndWait(buildExitWithCodeCommand(scripts, 1), 'Test Update rimraf');
    assert.notStrictEqual(exitCode, 0);

    provider.markPackageUpdating(identity, false);

    const after = findPackageItem('rimraf');
    assert.ok(after);
    assert.strictEqual(after.installing, false, 'Busy state must clear after a failing task — no stuck busy state');
    assert.strictEqual(after.currentVersion, originalVersion, 'A failing task must not apply the pending version');
  });
});

suite('Fixture Workspace Lifecycle', () => {
  test('Every fixture root opened during the run was deleted', () => {
    assert.ok(openedFixtureRoots.length > 0, 'At least one fixture should have been opened');
    for (const rootPath of openedFixtureRoots) {
      assert.strictEqual(existsSync(rootPath), false, `${rootPath} should have been cleaned up`);
    }
  });

  test('Workspace is back to the anchor baseline', () => {
    assert.strictEqual(countWorkspaceFolders(), ANCHOR_FOLDER_COUNT);
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const rootPath of openedFixtureRoots) {
      for (const folder of folders) {
        assert.strictEqual(isInside(rootPath, folder.uri.fsPath), false);
      }
    }
  });

  test('Extension Host was never restarted', () => {
    const hosts = recordedExtensionHosts();

    assert.deepStrictEqual(
      hosts,
      [process.pid],
      `Exactly one Extension Host should have loaded this suite, but ${hosts.length} did: ${hosts.join(', ')}. `
      + 'A second host means a workspace mutation replaced folder 0 and restarted the run.',
    );
  });
});