import * as assert from 'assert';
import * as vscode from 'vscode';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { ClientManager } from '../clients';
import { FilterManager, GroupItem, PackageItem, PackagesProvider } from '../providers';
import { resolveYarnFamily, runShellTaskAndWait } from '../utils';
import {
  awaitTaskOutcome,
  awaitTaskProcessStart,
  buildExitWithCodeCommand,
  buildSleepCommand,
  closeFixtureWorkspace,
  closeIfOpen,
  countWorkspaceFolders,
  createNoProcessTask,
  createPinnedManagerDir,
  createScriptFixture,
  fixtureTempRoot,
  materializeFixture,
  MULTI_ROOT_FIXTURES,
  openTrackedFixture,
  probeNativeTool,
  recordedExtensionHosts,
  recordExtensionHost,
  removeMaterializedFixture,
  removePinnedManagerDir,
  removeScriptFixture,
  resolveFixturePath,
  ROOT_MANIFEST_NESTED_PACKAGE,
  setNestroConfigValue,
  SINGLE_ROOT_FIXTURES,
  trackedFixtureRoots,
  waitUntil,
} from './fixtures';
import type { OpenedFixtureWorkspace, PinnedManagerDir, ScriptFixture, WorkspaceFixture } from './fixtures';
import type { PackageStateIdentity } from '../providers';

const EXTENSION_ID = 'greentech-solutions.nestro';

/** The single empty anchor folder of the generated `.code-workspace` file. */
const ANCHOR_FOLDER_COUNT = 1;

// Recorded on disk rather than in memory: a restart re-initializes any
// in-process copy of the pid along with the module holding it, so the evidence
// has to outlive the process it is meant to detect.
recordExtensionHost();

function requireExtension(): vscode.Extension<unknown> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, 'Extension should be registered');
  return extension;
}

/** Shape of the manifest fields this suite reads; `packageJSON` is typed `any` by `@types/vscode`. */
interface ManifestCommand {
  readonly command: string;
  readonly title: string;
  readonly category?: string;
  readonly enablement?: string;
}

interface ManifestMenuEntry {
  readonly command: string;
  readonly when: string;
  readonly group?: string;
}

interface WorkspaceCapability {
  readonly supported: boolean;
  readonly description: string;
}

interface ExtensionManifest {
  readonly capabilities: {
    readonly untrustedWorkspaces: WorkspaceCapability;
    readonly virtualWorkspaces: WorkspaceCapability;
  };
  readonly contributes: {
    readonly commands: readonly ManifestCommand[];
    readonly menus: {
      readonly commandPalette: readonly ManifestMenuEntry[];
      readonly 'view/item/context': readonly ManifestMenuEntry[];
    };
  };
  readonly extensionKind: readonly string[];
}

/** Reads the real, installed manifest rather than trusting a copy of `package.json` in test code. */
function getManifest(): ExtensionManifest {
  return requireExtension().packageJSON as ExtensionManifest;
}

function isInside(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath);
}

function toPosixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join('/');
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

  test('nestro.openAuditReport command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('nestro.openAuditReport'), 'Open audit report command should be registered');
  });

  test('nestro.openAuditReport executes safely when no audit has run', async () => {
    assert.strictEqual(await vscode.commands.executeCommand('nestro.openAuditReport'), undefined);
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

suite('command boundary smoke', function () {
  this.timeout(30000);

  const fixture = SINGLE_ROOT_FIXTURES[0];
  let opened: OpenedFixtureWorkspace | undefined;

  suiteSetup(async () => {
    opened = await openTrackedFixture(fixture);
  });

  suiteTeardown(async () => {
    await closeIfOpen(opened);
    opened = undefined;
  });

  test('registered install command rejects a forged row without writing the real manifest', async () => {
    const workspace = requireOpen(opened);
    const packageFilePath = resolveFixturePath(workspace.rootPath, 'npm-app/package.json');
    const original = readFileSync(packageFilePath, 'utf8');
    const restoreDeferredInstall = await setNestroConfigValue('deferInstallAfterUpdate', true);
    try {
      await vscode.commands.executeCommand('nestro.refresh');
      const forged = new PackageItem(
        'left-pad',
        '^1.3.0',
        '99.99.99',
        'breaking',
        undefined,
        undefined,
        packageFilePath,
        false,
        '^',
      );
      await vscode.commands.executeCommand('nestro.installUpdate', forged);

      // Command registrations intentionally fire-and-forget their async handlers;
      // allow that real Extension Host invocation to settle before checking bytes.
      await new Promise<void>(resolve => setTimeout(resolve, 250));
      assert.strictEqual(readFileSync(packageFilePath, 'utf8'), original);
    }
    finally {
      await restoreDeferredInstall();
    }
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
suite('Manager Detection Precedence', () => {
  function findSingleRootFixture(id: string): WorkspaceFixture {
    const fixture = SINGLE_ROOT_FIXTURES.find(candidate => candidate.id === id);
    assert.ok(fixture, `${id} fixture should exist in SINGLE_ROOT_FIXTURES`);
    return fixture;
  }

  async function detectForFixture(id: string): Promise<string> {
    const fixture = findSingleRootFixture(id);
    const opened = await openTrackedFixture(fixture);
    try {
      return await new ClientManager().detectPackageManager(opened.folders[0].uri.fsPath);
    }
    finally {
      await closeFixtureWorkspace(opened);
    }
  }

  test('packageManager manifest field wins over a competing lock file in the same directory', async () => {
    const fixture = findSingleRootFixture('precedence-field-over-lockfile');
    const opened = await openTrackedFixture(fixture);
    try {
      assert.strictEqual(
        existsSync(resolveFixturePath(opened.rootPath, 'field-over-lockfile-app/yarn.lock')),
        true,
        'The competing yarn.lock must genuinely exist, otherwise this only proves the absence of noise',
      );
      assert.strictEqual(await new ClientManager().detectPackageManager(opened.folders[0].uri.fsPath), 'pnpm');
    }
    finally {
      await closeFixtureWorkspace(opened);
    }
  });

  test('pnpm-lock.yaml wins over yarn.lock, bun.lock and package-lock.json', async () => {
    assert.strictEqual(await detectForFixture('precedence-pnpm-over-yarn-bun-npm'), 'pnpm');
  });

  test('yarn.lock wins over bun.lock and package-lock.json when pnpm-lock.yaml is absent', async () => {
    assert.strictEqual(await detectForFixture('precedence-yarn-over-bun-npm'), 'yarn');
  });

  test('bun.lock wins over package-lock.json when pnpm-lock.yaml and yarn.lock are absent', async () => {
    assert.strictEqual(await detectForFixture('precedence-bun-over-npm'), 'bun');
  });

  test('defaults to npm when no packageManager field and no lock file exist anywhere in the ancestor chain', async () => {
    const fixture = findSingleRootFixture('no-manager-signals');
    const opened = await openTrackedFixture(fixture);
    try {
      for (const lockFileName of ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'package-lock.json', 'npm-shrinkwrap.json']) {
        assert.strictEqual(
          existsSync(resolveFixturePath(opened.rootPath, `no-signals-app/${lockFileName}`)),
          false,
          `${lockFileName} must genuinely be absent for this to test the true default`,
        );
      }
      assert.strictEqual(await new ClientManager().detectPackageManager(opened.folders[0].uri.fsPath), 'npm');
    }
    finally {
      await closeFixtureWorkspace(opened);
    }
  });

  test('Yarn Modern without packageManager metadata resolves from Berry markers', async () => {
    const fixture = findSingleRootFixture('yarn-modern-no-metadata');
    const opened = await openTrackedFixture(fixture);
    try {
      const packageJsonPath = resolveFixturePath(opened.rootPath, 'yarn-modern-no-metadata-app/package.json');
      const manifestContents = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { packageManager?: string };
      assert.strictEqual(
        manifestContents.packageManager,
        undefined,
        'This fixture must genuinely omit packageManager — that is the dangerous case being proven',
      );
      assert.strictEqual(await new ClientManager().detectPackageManager(opened.folders[0].uri.fsPath), 'yarn');
      assert.deepStrictEqual(await resolveYarnFamily(opened.folders[0].uri.fsPath), {
        family: 'modern',
        source: 'project-markers',
      });
    }
    finally {
      await closeFixtureWorkspace(opened);
    }
  });

  test('Yarn Classic and metadata-pinned Yarn Modern resolve to explicit families', async () => {
    for (const [fixtureId, family, source] of [
      ['yarn-classic-single-root', 'classic', 'project-markers'],
      ['yarn-modern-single-root', 'modern', 'package-manager'],
    ] as const) {
      const opened = await openTrackedFixture(findSingleRootFixture(fixtureId));
      try {
        assert.deepStrictEqual(await resolveYarnFamily(opened.folders[0].uri.fsPath), { family, source });
      }
      finally {
        await closeFixtureWorkspace(opened);
      }
    }
  });

  test('conflicting Yarn family markers remain unknown without a default to Classic', async () => {
    const opened = await openTrackedFixture(findSingleRootFixture('yarn-ambiguous-markers'));
    try {
      assert.deepStrictEqual(await resolveYarnFamily(opened.folders[0].uri.fsPath), {
        family: 'unknown',
        source: 'conflicting-markers',
      });
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

    // Subscribed before the task starts, so the start event cannot be missed.
    const started = awaitTaskProcessStart(taskName);
    const outcomePromise = runShellTaskAndWait(buildSleepCommand(scripts), taskName);

    const execution = await started;
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
    assert.strictEqual(before.operation, undefined);

    const identity = identityFor(before);
    provider.markPackageUpdating(identity, { kind: 'update', target: '9.9.9' });
    assert.strictEqual(findPackageItem('left-pad')?.operation?.kind, 'update', 'Item should be marked with an update operation while the task runs');

    const exitCode = await runShellTaskAndWait(buildExitWithCodeCommand(scripts, 0), 'Test Update left-pad');
    assert.strictEqual(exitCode, 0);

    provider.invalidateUpdateCache();
    provider.markPackageUpdated(identity, '9.9.9');

    const after = findPackageItem('left-pad');
    assert.ok(after);
    assert.strictEqual(after.operation, undefined, 'Busy state must clear once the task exits successfully');
    assert.strictEqual(after.currentVersion, `${before.versionPrefix}9.9.9`);
  });

  test('clears busy state without applying the update after a failing task', async () => {
    const before = findPackageItem('rimraf');
    assert.ok(before, 'rimraf should be present after loadPackages()');
    const originalVersion = before.currentVersion;

    const identity = identityFor(before);
    provider.markPackageUpdating(identity, { kind: 'update', target: originalVersion });
    assert.strictEqual(findPackageItem('rimraf')?.operation?.kind, 'update', 'Item should be marked with an update operation while the task runs');

    const exitCode = await runShellTaskAndWait(buildExitWithCodeCommand(scripts, 1), 'Test Update rimraf');
    assert.notStrictEqual(exitCode, 0);

    provider.markPackageUpdating(identity, undefined);

    const after = findPackageItem('rimraf');
    assert.ok(after);
    assert.strictEqual(after.operation, undefined, 'Busy state must clear after a failing task — no stuck busy state');
    assert.strictEqual(after.currentVersion, originalVersion, 'A failing task must not apply the pending version');
  });
});

suite('Manifest Contracts', () => {
  test('contributes.commands has exactly the 19 documented entries', () => {
    assert.strictEqual(getManifest().contributes.commands.length, 19);
  });

  test('declares unsupported workspace modes and workspace-side execution', () => {
    const manifest = getManifest();
    assert.deepStrictEqual(manifest.capabilities, {
      untrustedWorkspaces: {
        supported: false,
        description: 'Nestro reads local package files and runs package-manager processes.',
      },
      virtualWorkspaces: {
        supported: false,
        description: 'Nestro requires local package files and package-manager processes.',
      },
    });
    assert.deepStrictEqual(manifest.extensionKind, ['workspace']);
  });

  test('row capabilities keep update actions working and hide pin for unsupported specs', () => {
    const item = new PackageItem('left-pad', '1.0.0', '1.1.0', 'minor', undefined, 'high', '/workspace/package.json', false, '^');
    assert.strictEqual(item.contextValue, 'outdated-pinnable-vulnerable-high');

    const menuEntries = getManifest().contributes.menus['view/item/context'];
    const installUpdateEntry = menuEntries.find(entry => entry.command === 'nestro.installUpdate');
    assert.ok(installUpdateEntry, 'nestro.installUpdate should have a view/item/context menu entry');
    assert.strictEqual(installUpdateEntry.when, 'view == nestro.packagesView && viewItem =~ /(^|-)outdated($|-)/');
    const updateRegexSource = /viewItem =~ \/(.+)\//.exec(installUpdateEntry.when)?.[1];
    assert.strictEqual(typeof updateRegexSource, 'string');
    assert.strictEqual(new RegExp(updateRegexSource ?? '').test(item.contextValue as string), true);

    // All row actions that use a state-bearing contextValue must match its capability token.
    const pickVersionEntry = menuEntries.find(entry => entry.command === 'nestro.pickVersion');
    assert.ok(pickVersionEntry, 'nestro.pickVersion should have a view/item/context menu entry');
    const viewItemRegexSource = /viewItem =~ \/(.+)\//.exec(pickVersionEntry.when)?.[1];
    assert.ok(viewItemRegexSource, 'nestro.pickVersion should use a regex viewItem match');
    assert.ok(new RegExp(viewItemRegexSource).test(item.contextValue as string));

    const pinEntries = menuEntries.filter(entry => entry.command === 'nestro.pinVersion');
    assert.strictEqual(pinEntries.length, 2);
    for (const pinEntry of pinEntries) {
      const pinRegexSource = /viewItem =~ \/(.+)\//.exec(pinEntry.when)?.[1];
      assert.strictEqual(typeof pinRegexSource, 'string');
      assert.strictEqual(new RegExp(pinRegexSource ?? '').test(item.contextValue as string), true);
    }

    const unsupported = new PackageItem('local-pkg', 'file:../local-pkg', undefined, 'none');
    assert.strictEqual(unsupported.contextValue, 'package-pin-unsupported');
    assert.strictEqual(unsupported.tooltip?.toString().includes('Pin unavailable: local file dependency'), true);
    for (const pinEntry of pinEntries) {
      const pinRegexSource = /viewItem =~ \/(.+)\//.exec(pinEntry.when)?.[1];
      assert.strictEqual(new RegExp(pinRegexSource ?? '').test(unsupported.contextValue as string), false);
    }
  });

  // Row-only and contextual commands have no meaningful effect when triggered outside their
  // row/context, so they are excluded from the Command Palette entirely via a `when: false` menu entry.
  const PALETTE_HIDDEN_COMMAND_IDS = [
    'nestro.setFilter',
    'nestro.showFilterPicker',
    'nestro.installUpdate',
    'nestro.pickVersion',
    'nestro.switchDepType',
    'nestro.pinVersion',
    'nestro.removePackage',
    'nestro.openOnNpm',
    'nestro.copyPackageName',
    'nestro.clearSearchQuery',
  ] as const;

  test('row-only and contextual commands are hidden from the Command Palette', () => {
    const paletteEntries = getManifest().contributes.menus.commandPalette;
    for (const commandId of PALETTE_HIDDEN_COMMAND_IDS) {
      const entry = paletteEntries.find(candidate => candidate.command === commandId);
      assert.ok(entry, `${commandId} should have a commandPalette menu entry`);
      assert.strictEqual(entry.when, 'false', `${commandId} should be hidden from the Command Palette`);
    }
    assert.strictEqual(
      paletteEntries.length,
      PALETTE_HIDDEN_COMMAND_IDS.length,
      'every commandPalette override should be one of the hidden row-only/contextual commands',
    );
  });

  test('every command still visible in the Command Palette carries the Nestro category', () => {
    const hiddenIds = new Set<string>(PALETTE_HIDDEN_COMMAND_IDS);
    const visibleCommands = getManifest().contributes.commands.filter(entry => !hiddenIds.has(entry.command));
    assert.ok(visibleCommands.length > 0, 'at least one command should remain visible in the Command Palette');
    for (const command of visibleCommands) {
      assert.strictEqual(command.category, 'Nestro', `${command.command} should carry the Nestro category`);
    }
  });

  test('nestro.updateAllVisible is only enabled while a visible package actually has an update', () => {
    const command = getManifest().contributes.commands.find(entry => entry.command === 'nestro.updateAllVisible');
    assert.ok(command, 'nestro.updateAllVisible should be a contributed command');
    assert.strictEqual(command.enablement, 'nestro.canUpdateVisiblePackages');
  });
});

suite('Contributed Command Surface: invocation without arguments', function () {
  this.timeout(30000);

  /**
   * Every row-only command handler has a typed `isPackageItem()` guard as its first statement,
   * so every contributed command resolves `executeCommand()` with no unhandled rejection when
   * invoked with no argument — even though hidden from the Palette, `executeCommand()` still
   * reaches the real handler directly through the API regardless of Palette visibility.
   */
  const COMMAND_IDS_UNDER_TEST: readonly string[] = [
    'nestro.refresh',
    'nestro.checkUpdates',
    'nestro.runAudit',
    'nestro.openAuditReport',
    'nestro.installUpdate',
    'nestro.pickVersion',
    'nestro.switchDepType',
    'nestro.pinVersion',
    'nestro.removePackage',
    'nestro.updateAllVisible',
    'nestro.runInstall',
    'nestro.openOnNpm',
    'nestro.copyPackageName',
    'nestro.setFilter',
    'nestro.showFilterPicker',
    'nestro.searchPackages',
    'nestro.clearSearchQuery',
    'nestro.openSettings',
    'nestro.pinAllVersions',
  ];

  let commandIds: string[];
  let unhandledRejections: unknown[];
  let onUnhandledRejection: (reason: unknown) => void;

  suiteSetup(() => {
    commandIds = getManifest().contributes.commands.map(entry => entry.command);
    unhandledRejections = [];
    onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
  });

  suiteTeardown(async () => {
    process.off('unhandledRejection', onUnhandledRejection);
    // nestro.setFilter has no argument guard and silently accepts `undefined` (getFilteredEntries()
    // in treeBuilder.ts tolerates an unrecognized filter by matching nothing) — restore the
    // default so later runs of this file are not affected by this suite having executed.
    await vscode.commands.executeCommand('nestro.setFilter', 'all');
    // nestro.searchPackages opens a real, non-modal InputBox that only
    // resolves on hide/accept; since its handler is fire-and-forget it is
    // never awaited by executeCommand(), so it is closed explicitly here.
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  });

  test('contributes.commands still has exactly the 19 entries this suite enumerates', () => {
    assert.strictEqual(commandIds.length, 19, 'A manifest command count drift means COMMAND_IDS_UNDER_TEST above is stale');
    const localeCompare = (left: string, right: string): number => left.localeCompare(right);
    assert.deepStrictEqual([...commandIds].sort(localeCompare), [...COMMAND_IDS_UNDER_TEST].sort(localeCompare));
  });

  for (const commandId of COMMAND_IDS_UNDER_TEST) {
    test(`${commandId} does not crash the Extension Host when invoked with no arguments`, async () => {
      unhandledRejections.length = 0;
      let rejection: unknown;
      try {
        await vscode.commands.executeCommand(commandId);
      }
      catch (err) {
        rejection = err;
      }

      // searchPackages/showFilterPicker are fire-and-forget: a QuickPick or InputBox they open
      // is never awaited by executeCommand() and would otherwise sit open in the background for
      // the rest of this loop, so it is closed explicitly here.
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      if (commandId === 'nestro.openSettings') {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      }

      // Give a fire-and-forget internal promise a turn of the microtask queue to reject and be
      // observed by the process-level listener above — there is no state to poll here, only the
      // (im)possibility of an event Node schedules on its own.
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));

      assert.strictEqual(rejection, undefined, `${commandId} should resolve executeCommand() — the isPackageItem() guard (row-only commands) or the absence of any argument dereference (global commands) prevents a thrown/rejected TypeError`);
      assert.strictEqual(unhandledRejections.length, 0, `${commandId} should not leave any unhandled background rejection`);
    });
  }

  test('the Extension Host is still fully responsive after invoking all 19 commands with no arguments', async () => {
    const registered = await vscode.commands.getCommands(true);
    for (const commandId of commandIds) {
      assert.ok(registered.includes(commandId), `${commandId} should still be registered`);
    }
    // A trivial round trip through the command dispatcher proves the host loop is alive.
    await vscode.commands.executeCommand('nestro.refresh');
  });
});

suite('Native Package Manager Smoke (bun, yarn)', function () {
  this.timeout(60000);

  let pinnedYarnClassic: PinnedManagerDir;
  let pinnedYarnModern: PinnedManagerDir;

  suiteSetup(async () => {
    pinnedYarnClassic = await createPinnedManagerDir('yarn@1.22.19');
    pinnedYarnModern = await createPinnedManagerDir('yarn@4.6.0');
  });

  suiteTeardown(async () => {
    await removePinnedManagerDir(pinnedYarnClassic);
    await removePinnedManagerDir(pinnedYarnModern);
  });

  test('bun --version reports a version when bun is installed', async function () {
    const probe = await probeNativeTool('bun', ['--version']);
    if (!probe.available) {
      console.warn(`[native-smoke] Skipping: bun is not available on this machine (${probe.reason}).`);
      this.skip();
      return;
    }
    assert.match(probe.output ?? '', /^\d+\.\d+\.\d+/, 'bun --version should print a semver-looking version string');
  });

  test('yarn --version reports a version when yarn is available through Corepack', async function () {
    // Run from the system temp root, not the repository: this repo's own `packageManager:
    // "pnpm@..."` pin makes Corepack refuse to run `yarn` at all from inside the working tree,
    // which would masquerade as "yarn is not installed" here.
    const probe = await probeNativeTool('yarn', ['--version'], await fixtureTempRoot());
    if (!probe.available) {
      console.warn(`[native-smoke] Skipping: yarn is not available on this machine (${probe.reason}).`);
      this.skip();
      return;
    }
    assert.match(probe.output ?? '', /^\d+\.\d+\.\d+/, 'yarn --version should print a semver-looking version string');
  });

  test('Corepack transparently resolves the exact Yarn Classic release pinned by packageManager', async function () {
    const probe = await probeNativeTool('yarn', ['--version'], pinnedYarnClassic.dir);
    if (!probe.available) {
      console.warn(`[native-smoke] Skipping: yarn is not available on this machine (${probe.reason}).`);
      this.skip();
      return;
    }
    assert.strictEqual(
      probe.output,
      '1.22.19',
      'Corepack should run the exact pinned Yarn Classic release inside this directory, not whatever yarn resolves to on PATH',
    );
  });

  test('Corepack transparently resolves the exact Yarn Modern release pinned by packageManager', async function () {
    const probe = await probeNativeTool('yarn', ['--version'], pinnedYarnModern.dir);
    if (!probe.available) {
      console.warn(`[native-smoke] Skipping: yarn is not available on this machine (${probe.reason}).`);
      this.skip();
      return;
    }
    assert.strictEqual(
      probe.output,
      '4.6.0',
      'Corepack should run the exact pinned Yarn Modern release inside this directory, not whatever yarn resolves to on PATH',
    );
  });
});

/**
 * Audits what every test file left behind. A root-level hook — declared outside
 * any `suite()` — is what guarantees this runs after all of them: the runner's
 * file order is not alphabetical and must not be relied on.
 */
suiteTeardown(function () {
  const roots = trackedFixtureRoots();
  assert.ok(roots.length > 0, 'At least one fixture should have been opened');

  for (const rootPath of roots) {
    assert.strictEqual(existsSync(rootPath), false, `${rootPath} should have been cleaned up`);
  }

  assert.strictEqual(countWorkspaceFolders(), ANCHOR_FOLDER_COUNT, 'Workspace should be back to the anchor baseline');
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    for (const rootPath of roots) {
      assert.strictEqual(isInside(rootPath, folder.uri.fsPath), false, `${folder.uri.fsPath} outlived its fixture`);
    }
  }

  const hosts = recordedExtensionHosts();
  assert.deepStrictEqual(
    hosts,
    [process.pid],
    `Exactly one Extension Host should have loaded the suite, but ${hosts.length} did: ${hosts.join(', ')}. `
    + 'A second host means a workspace mutation replaced folder 0 and restarted the run.',
  );
});