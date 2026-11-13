import * as assert from 'assert';
import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { FILTER_TYPES } from '../providers/FilterManager';
import { COMMAND_IDS, CONTEXT_KEYS, VIEW_IDS } from '../shared';
import {
  buildPackageItem,
  closeIfOpen,
  openTrackedFixture,
  resolveFixturePath,
  setNestroConfigValue,
  SINGLE_ROOT_FIXTURES,
} from './fixtures';
import type { OpenedFixtureWorkspace } from './fixtures';
import { compileViewItemPattern, getManifest, requireExtension, requireOpen } from './fixtures/extensionManifest';

suite('command boundary smoke', function () {
  this.timeout(30000);

  const fixture = SINGLE_ROOT_FIXTURES[0];
  let opened: OpenedFixtureWorkspace | undefined;

  suiteSetup(async () => {
    await requireExtension().activate();
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
      const forged = buildPackageItem({
        name: 'left-pad',
        currentVersion: '^1.3.0',
        latest: '99.99.99',
        updateType: 'breaking',
        packageFilePath,
        versionPrefix: '^',
      });
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

// Smoke only: the extension exports no API, so a host test cannot read the active filter back.
// The behavioural matrix lives in the unit suite, which can observe the provider call.
suite('nestro.setFilter argument guard', function () {
  this.timeout(30000);

  const fixture = SINGLE_ROOT_FIXTURES[0];
  let opened: OpenedFixtureWorkspace | undefined;

  suiteSetup(async () => {
    await requireExtension().activate();
    opened = await openTrackedFixture(fixture);
    await vscode.commands.executeCommand('nestro.refresh');
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('nestro.setFilter', 'all');
    await closeIfOpen(opened);
    opened = undefined;
  });

  const REJECTED_FILTER_VALUES: readonly { readonly label: string; readonly value: unknown }[] = [
    { label: 'undefined', value: undefined },
    { label: 'null', value: null },
    { label: 'an empty string', value: '' },
    { label: 'an arbitrary string', value: 'not-a-filter' },
    { label: 'a number', value: 42 },
    { label: 'a plain object', value: {} },
  ];

  for (const { label, value } of REJECTED_FILTER_VALUES) {
    test(`survives ${label} without throwing, leaving the workspace refreshable`, async () => {
      requireOpen(opened);
      await vscode.commands.executeCommand('nestro.setFilter', value);
      await vscode.commands.executeCommand('nestro.refresh');
    });
  }

  for (const filterType of FILTER_TYPES) {
    test(`accepts the valid "${filterType}" filter without throwing`, async () => {
      requireOpen(opened);
      await vscode.commands.executeCommand('nestro.setFilter', filterType);
      await vscode.commands.executeCommand('nestro.refresh');
    });
  }
});

suite('Manifest Contracts', () => {
  test('contributes.commands has exactly the 21 documented entries', () => {
    assert.strictEqual(getManifest().contributes.commands.length, 21);
  });

  // Global commands gate on capability contexts published only after the provider's first
  // load, so a workspace holding a package.json activates without opening the sidebar first.
  test('activates on a package.json without waiting for the sidebar to open', () => {
    assert.deepStrictEqual(getManifest().activationEvents, ['workspaceContains:package.json']);
  });

  test('declares unsupported workspace modes and workspace-side execution', () => {
    const catalog = JSON.parse(readFileSync(`${requireExtension().extensionPath}/package.nls.json`, 'utf8')) as Readonly<Record<string, string>>;
    assert.deepStrictEqual(getManifest().capabilities, {
      untrustedWorkspaces: {
        supported: false,
        description: catalog['capabilities.untrustedWorkspaces.description'],
      },
      virtualWorkspaces: {
        supported: false,
        description: catalog['capabilities.virtualWorkspaces.description'],
      },
    });
    assert.deepStrictEqual(getManifest().extensionKind, ['workspace']);
  });

  test('row capabilities keep update actions working and hide pin for unsupported specs', () => {
    const item = buildPackageItem({ name: 'left-pad', currentVersion: '1.0.0', latest: '1.1.0', updateType: 'minor', operation: false, vulnerabilitySeverity: 'high', packageFilePath: '/workspace/package.json', versionPrefix: '^' });
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
    assert.strictEqual(pinEntries.length, 1);
    for (const pinEntry of pinEntries) {
      const pinRegexSource = /viewItem =~ \/(.+)\//.exec(pinEntry.when)?.[1];
      assert.strictEqual(typeof pinRegexSource, 'string');
      assert.strictEqual(new RegExp(pinRegexSource ?? '').test(item.contextValue as string), true);
    }

    const unsupported = buildPackageItem({ name: 'local-pkg', currentVersion: 'file:../local-pkg', updateType: 'none', operation: false, vulnerabilitySeverity: undefined, packageFilePath: '', versionPrefix: '' });
    assert.strictEqual(unsupported.contextValue, 'package-pin-unsupported');
    assert.strictEqual(unsupported.tooltip?.toString().includes('Pin unavailable: local file dependency'), true);
    for (const pinEntry of pinEntries) {
      const pinRegexSource = /viewItem =~ \/(.+)\//.exec(pinEntry.when)?.[1];
      assert.strictEqual(new RegExp(pinRegexSource ?? '').test(unsupported.contextValue as string), false);
    }
  });

  test('package row actions stay reachable with no more than two inline actions', () => {
    const rowMenus = getManifest().contributes.menus['view/item/context']
      .filter(entry => entry.when.includes('viewItem =~'));
    assert.deepStrictEqual(rowMenus.map(entry => [entry.command, entry.group]), [
      ['nestro.installUpdate', 'inline'],
      ['nestro.pickVersion', 'inline@2'],
      ['nestro.openOnNpm', 'navigation@1'],
      ['nestro.copyPackageName', 'navigation@2'],
      ['nestro.switchDepType', '2_manage@1'],
      ['nestro.pinVersion', '2_manage@2'],
      ['nestro.removePackage', '3_danger@1'],
    ]);
    assert.strictEqual(new Set(rowMenus.map(entry => entry.command)).size, rowMenus.length);

    const rowCases = [
      {
        label: 'outdated vulnerable pinnable',
        item: buildPackageItem({ name: 'pkg', currentVersion: '^1.0.0', latest: '1.1.0', updateType: 'minor', operation: false, vulnerabilitySeverity: 'high' }),
        commandIds: [
          'nestro.installUpdate',
          'nestro.pickVersion',
          'nestro.openOnNpm',
          'nestro.copyPackageName',
          'nestro.switchDepType',
          'nestro.pinVersion',
          'nestro.removePackage',
        ],
        inlineCommandIds: ['nestro.installUpdate', 'nestro.pickVersion'],
      },
      {
        label: 'outdated vulnerable pin-unsupported',
        item: buildPackageItem({ name: 'local-pkg', currentVersion: 'npm:real-pkg@^1.0.0', latest: '2.0.0', updateType: 'breaking', operation: false, vulnerabilitySeverity: 'critical' }),
        commandIds: [
          'nestro.installUpdate',
          'nestro.pickVersion',
          'nestro.openOnNpm',
          'nestro.copyPackageName',
          'nestro.switchDepType',
          'nestro.removePackage',
        ],
        inlineCommandIds: ['nestro.installUpdate', 'nestro.pickVersion'],
      },
      {
        label: 'current pinnable',
        item: buildPackageItem({ name: 'stable', currentVersion: '^1.0.0', updateType: 'none', operation: false, vulnerabilitySeverity: undefined }),
        commandIds: [
          'nestro.pickVersion',
          'nestro.openOnNpm',
          'nestro.copyPackageName',
          'nestro.switchDepType',
          'nestro.pinVersion',
          'nestro.removePackage',
        ],
        inlineCommandIds: ['nestro.pickVersion'],
      },
      {
        label: 'installing vulnerable',
        item: buildPackageItem({ name: 'pending', currentVersion: '^1.0.0', latest: '2.0.0', updateType: 'minor', operation: { kind: 'update', target: '2.0.0' }, vulnerabilitySeverity: 'high' }),
        commandIds: ['nestro.openOnNpm', 'nestro.copyPackageName'],
        inlineCommandIds: [],
      },
    ] as const;

    for (const { label, item, commandIds, inlineCommandIds } of rowCases) {
      const matchingMenus = rowMenus.filter(entry => compileViewItemPattern(entry.when).test(item.contextValue ?? ''));
      assert.deepStrictEqual(matchingMenus.map(entry => entry.command), commandIds, label);
      assert.deepStrictEqual(
        matchingMenus.filter(entry => entry.group?.startsWith('inline') === true).map(entry => entry.command),
        inlineCommandIds,
        `${label} inline actions`,
      );
      assert.ok(inlineCommandIds.length <= 2, `${label} should have at most two inline actions`);
    }
  });

  test('clear Search is inline only for the active search status row', () => {
    const entry = getManifest().contributes.menus['view/item/context']
      .find(candidate => candidate.command === COMMAND_IDS.clearSearchQuery);

    assert.ok(entry, 'nestro.clearSearchQuery should have a view/item/context menu entry');
    assert.strictEqual(entry.when, `view == ${VIEW_IDS.packages} && viewItem == status-search-active`);
    assert.strictEqual(entry.group, 'inline');
  });

  // Row-only and contextual commands have no meaningful effect outside their row/context, so
  // the manifest hides them from the Command Palette with a `when: false` menu entry.
  const PALETTE_GATED_COMMANDS: Readonly<Record<string, string>> = {
    [COMMAND_IDS.updateAllVisible]: CONTEXT_KEYS.canUpdateVisiblePackages,
    [COMMAND_IDS.runInstall]: CONTEXT_KEYS.canRunInstall,
    [COMMAND_IDS.searchPackages]: CONTEXT_KEYS.canSearchPackages,
    [COMMAND_IDS.runAudit]: CONTEXT_KEYS.canRunAudit,
    [COMMAND_IDS.pinAllVersions]: CONTEXT_KEYS.canPinAllVersions,
  };

  const getPaletteHiddenCommandIds = (): string[] => getManifest().contributes.menus.commandPalette
    .filter(entry => entry.when === 'false')
    .map(entry => entry.command);

  test('every commandPalette override hides its command or gates it by capability', () => {
    const paletteEntries = getManifest().contributes.menus.commandPalette;
    for (const entry of paletteEntries) {
      assert.ok(
        entry.when === 'false' || entry.when === PALETTE_GATED_COMMANDS[entry.command],
        `${entry.command} commandPalette override should be hidden or capability-gated`,
      );
    }
    for (const [commandId, context] of Object.entries(PALETTE_GATED_COMMANDS)) {
      const entry = paletteEntries.find(candidate => candidate.command === commandId);
      assert.ok(entry, `${commandId} should have a capability-gated commandPalette entry`);
      assert.strictEqual(entry.when, context, `${commandId} should use ${context}`);
    }
  });

  test('every command still visible in the Command Palette carries the Nestro category', () => {
    const hiddenIds = new Set<string>(getPaletteHiddenCommandIds());
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

  test('global actions expose their executable workspace capabilities', () => {
    const commands = getManifest().contributes.commands;
    // nestro.searchPackages carries no command enablement — its row binds it through
    // TreeItem.command (viewProjectionService.ts), and visibility is when-gated below instead.
    for (const [commandId, context] of Object.entries({
      [COMMAND_IDS.runInstall]: CONTEXT_KEYS.canRunInstall,
      [COMMAND_IDS.runAudit]: CONTEXT_KEYS.canRunAudit,
      [COMMAND_IDS.pinAllVersions]: CONTEXT_KEYS.canPinAllVersions,
    })) {
      const command = commands.find(entry => entry.command === commandId);
      assert.ok(command, `${commandId} should be a contributed command`);
      assert.strictEqual(command.enablement, context);
    }
    assert.strictEqual(
      commands.find(entry => entry.command === 'nestro.searchPackages')?.enablement,
      undefined,
      'nestro.searchPackages must carry no enablement — it is bound through TreeItem.command',
    );

    const toolbarEntries = getManifest().contributes.menus['view/title'];
    for (const [commandId, context] of Object.entries({
      [COMMAND_IDS.runInstall]: CONTEXT_KEYS.canRunInstall,
      [COMMAND_IDS.runAudit]: CONTEXT_KEYS.canRunAudit,
      [COMMAND_IDS.searchPackages]: CONTEXT_KEYS.canSearchPackages,
      [COMMAND_IDS.pinAllVersions]: CONTEXT_KEYS.canPinAllVersions,
    })) {
      const entry = toolbarEntries.find(candidate => candidate.command === commandId);
      assert.ok(entry, `${commandId} should have a toolbar menu entry`);
      assert.strictEqual(entry.when, `view == ${VIEW_IDS.packages} && ${context}`);
    }
  });

  // The narrow view toolbar renders only the navigation group inline; everything else
  // collapses into the "..." overflow, so the installed manifest must cap navigation at three.
  test('the view toolbar keeps exactly three primary navigation actions, in order', () => {
    const toolbarEntries = getManifest().contributes.menus['view/title'];
    const navigationEntries = toolbarEntries.filter(entry => entry.group === 'navigation' || entry.group?.startsWith('navigation@') === true);
    assert.deepStrictEqual(navigationEntries.map(entry => entry.command), [
      'nestro.refresh',
      'nestro.checkUpdates',
      'nestro.updateAllVisible',
    ]);
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
  const COMMAND_IDS_UNDER_TEST: readonly string[] = Object.values(COMMAND_IDS);

  let commandIds: string[];
  let unhandledRejections: unknown[];
  let onUnhandledRejection: (reason: unknown) => void;

  suiteSetup(async () => {
    await requireExtension().activate();
    commandIds = getManifest().contributes.commands.map(entry => entry.command);
    unhandledRejections = [];
    onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
  });

  suiteTeardown(async () => {
    process.off('unhandledRejection', onUnhandledRejection);
    // Explicit reset so later runs of this file see a known filter regardless of
    // whichever command last ran in the loop above.
    await vscode.commands.executeCommand('nestro.setFilter', 'all');
    // nestro.searchPackages opens a real, non-modal InputBox that only
    // resolves on hide/accept; since its handler is fire-and-forget it is
    // never awaited by executeCommand(), so it is closed explicitly here.
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  });

  test('contributes.commands still has exactly the entries of COMMAND_IDS', () => {
    assert.strictEqual(commandIds.length, COMMAND_IDS_UNDER_TEST.length, 'A manifest command count drift means COMMAND_IDS in src/shared/ids.ts is stale');
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
      if (commandId === COMMAND_IDS.openSettings) {
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

  test('the Extension Host is still fully responsive after invoking every command with no arguments', async () => {
    const registered = await vscode.commands.getCommands(true);
    for (const commandId of commandIds) {
      assert.ok(registered.includes(commandId), `${commandId} should still be registered`);
    }
    // A trivial round trip through the command dispatcher proves the host loop is alive.
    await vscode.commands.executeCommand('nestro.refresh');
  });
});