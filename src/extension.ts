import * as vscode from 'vscode';
import { FilterManager, isFilterType, PackageItem, PackagesProvider } from './providers';
import type { FilterType } from './providers';
import {
  installUpdateCommand,
  pickVersionCommand,
  pinVersionCommand,
  runInstallCommand,
  switchDepTypeCommand,
  updateAllVisibleCommand,
} from './commands';
import { logger } from './utils';

export function activate(context: vscode.ExtensionContext): void {
  logger.info('Extension activated.');

  const config = vscode.workspace.getConfiguration('nestro');
  const configuredDefaultFilter = config.get<unknown>('defaultFilter', 'all');
  const defaultFilter: FilterType = isFilterType(configuredDefaultFilter) ? configuredDefaultFilter : 'all';
  const filterManager = new FilterManager(defaultFilter);
  const provider = new PackagesProvider(filterManager);
  const treeView = vscode.window.createTreeView('nestro.packagesView', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  provider.attachTreeView(treeView);
  const checkUpdatesOnStartup = config.get<boolean>('checkUpdatesOnStartup', false);
  const runAuditOnStartup = config.get<boolean>('runAuditOnStartup', false);

  context.subscriptions.push(
    treeView,
    vscode.commands.registerCommand('nestro.refresh', () => { void provider.loadPackages(); }),
    vscode.commands.registerCommand('nestro.checkUpdates', () => { void provider.checkUpdates(); }),
    vscode.commands.registerCommand('nestro.runAudit', () => { void provider.runAudit(); }),
    vscode.commands.registerCommand('nestro.installUpdate', (item: PackageItem) => { void installUpdateCommand(item, provider); }),
    vscode.commands.registerCommand('nestro.pickVersion', (item: PackageItem) => { void pickVersionCommand(item, provider); }),
    vscode.commands.registerCommand('nestro.switchDepType', (item: PackageItem) => { void switchDepTypeCommand(item, provider); }),
    vscode.commands.registerCommand('nestro.pinVersion', (item: PackageItem) => { void pinVersionCommand(item, provider); }),
    vscode.commands.registerCommand('nestro.runInstall', () => { void runInstallCommand(); }),
    vscode.commands.registerCommand('nestro.updateAllVisible', () => { void updateAllVisibleCommand(provider); }),
    vscode.commands.registerCommand('nestro.openOnNpm', (item: PackageItem) => {
      void vscode.env.openExternal(vscode.Uri.parse(`https://www.npmjs.com/package/${item.packageName}`));
    }),
    vscode.commands.registerCommand('nestro.copyPackageName', (item: PackageItem) => {
      void vscode.env.clipboard.writeText(item.packageName);
    }),
    vscode.commands.registerCommand('nestro.setFilter', (type: FilterType) => provider.setFilter(type)),
    vscode.commands.registerCommand('nestro.showFilterPicker', () => { void provider.showFilterPicker(); }),
    vscode.commands.registerCommand('nestro.openSettings', () => {
      void vscode.commands.executeCommand('workbench.action.openSettings', 'nestro');
    }),
    logger,
    filterManager,
    provider,
  );

  registerPackageJsonWatcher(context, provider);
  registerConfigurationWatcher(context, provider);

  void provider.loadPackages().then(() => {
    if (checkUpdatesOnStartup) {
      void provider.checkUpdates();
    }
    if (runAuditOnStartup) {
      void provider.runAudit();
    }
  });
}

export function deactivate(): void {}

export function registerPackageJsonWatcher(
  context: vscode.ExtensionContext,
  provider: Pick<PackagesProvider, 'invalidateUpdateCache' | 'loadPackages' | 'suppressingWrites'>,
): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) {
    return;
  }

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      folder,
      vscode.workspace.getConfiguration('nestro').get<string>('monorepoGlob', '**/package.json'),
    ),
  );
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleRefresh = (): void => {
    if (provider.suppressingWrites) {
      return;
    }
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      provider.invalidateUpdateCache();
      void provider.loadPackages();
    }, 500);
  };

  context.subscriptions.push(
    watcher,
    watcher.onDidChange(scheduleRefresh),
    watcher.onDidCreate(scheduleRefresh),
    watcher.onDidDelete(() => {
      clearTimeout(debounceTimer);
      provider.invalidateUpdateCache();
      void provider.loadPackages();
    }),
  );
}

export function registerConfigurationWatcher(
  context: vscode.ExtensionContext,
  provider: Pick<PackagesProvider, 'invalidateUpdateCache' | 'loadPackages' | 'resetUpdateData' | 'setFilter'>,
): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('nestro.defaultFilter')) {
        const raw = vscode.workspace.getConfiguration('nestro').get<unknown>('defaultFilter', 'all');
        const next: FilterType = isFilterType(raw) ? raw : 'all';
        provider.setFilter(next);
      }
      if (
        e.affectsConfiguration('nestro.updateTarget')
        || e.affectsConfiguration('nestro.includePreReleases')
      ) {
        provider.invalidateUpdateCache();
        provider.resetUpdateData();
      }
      if (e.affectsConfiguration('nestro.monorepoGlob')) {
        provider.invalidateUpdateCache();
        void provider.loadPackages();
      }
    }),
  );
}