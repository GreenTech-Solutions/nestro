import * as vscode from 'vscode';
import { FilterManager, isFilterType, PackagesProvider } from './providers';
import type { FilterType } from './providers';
import {
  copyPackageNameCommand,
  installUpdateCommand,
  openAuditReportCommand,
  openOnNpmCommand,
  pickVersionCommand,
  pinAllVersionsCommand,
  pinVersionCommand,
  removePackageCommand,
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
  const auditReportOutput = vscode.window.createOutputChannel(vscode.l10n.t('Nestro Security Audit'));
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
    auditReportOutput,
    vscode.commands.registerCommand('nestro.openAuditReport', () => {
      openAuditReportCommand(provider, auditReportOutput);
    }),
    vscode.commands.registerCommand('nestro.installUpdate', (item: unknown) => { void installUpdateCommand(item, provider); }),
    vscode.commands.registerCommand('nestro.pickVersion', (item: unknown) => { void pickVersionCommand(item, provider); }),
    vscode.commands.registerCommand('nestro.switchDepType', (item: unknown) => { void switchDepTypeCommand(item, provider); }),
    vscode.commands.registerCommand('nestro.pinVersion', (item: unknown) => { void pinVersionCommand(item, provider); }),
    vscode.commands.registerCommand('nestro.removePackage', (item: unknown) => { void removePackageCommand(item, provider); }),
    vscode.commands.registerCommand('nestro.runInstall', () => { void runInstallCommand(provider); }),
    vscode.commands.registerCommand('nestro.updateAllVisible', () => { void updateAllVisibleCommand(provider); }),
    vscode.commands.registerCommand('nestro.pinAllVersions', () => { void pinAllVersionsCommand(provider); }),
    vscode.commands.registerCommand('nestro.openOnNpm', (item: unknown) => { openOnNpmCommand(item); }),
    vscode.commands.registerCommand('nestro.copyPackageName', (item: unknown) => { copyPackageNameCommand(item); }),
    vscode.commands.registerCommand('nestro.setFilter', (type: unknown) => {
      if (!isFilterType(type)) {
        return;
      }
      provider.setFilter(type);
    }),
    vscode.commands.registerCommand('nestro.showFilterPicker', () => { void provider.showFilterPicker(); }),
    vscode.commands.registerCommand('nestro.searchPackages', () => { void provider.showSearch(); }),
    vscode.commands.registerCommand('nestro.clearSearchQuery', () => { provider.clearSearch(); }),
    vscode.commands.registerCommand('nestro.openSettings', () => {
      void vscode.commands.executeCommand('workbench.action.openSettings', 'nestro');
    }),
    logger,
    filterManager,
    provider,
  );

  const packageJsonWatcher = registerPackageJsonWatcher(context, provider);
  registerConfigurationWatcher(context, provider, () => packageJsonWatcher.refresh());
  registerWorkspaceFoldersWatcher(context, provider, () => packageJsonWatcher.refresh());

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

export function registerWorkspaceFoldersWatcher(
  context: vscode.ExtensionContext,
  provider: Pick<PackagesProvider, 'loadPackages'>,
  refreshPackageJsonWatcher: () => void,
): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      refreshPackageJsonWatcher();
      void provider.loadPackages();
    }),
  );
}

/** Filesystem-event coalescing window: each event restarts the timer, so writes faster than this interval never trigger a reload. */
export const PACKAGE_JSON_WATCHER_DEBOUNCE_MS = 500;

export function registerPackageJsonWatcher(
  context: vscode.ExtensionContext,
  provider: Pick<PackagesProvider, 'invalidateUpdateCache' | 'loadPackages' | 'suppressingWrites'>,
): vscode.Disposable & { refresh(): void } {
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleRefresh = (): void => {
    if (provider.suppressingWrites) {
      return;
    }
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      provider.invalidateUpdateCache();
      void provider.loadPackages();
    }, PACKAGE_JSON_WATCHER_DEBOUNCE_MS);
  };

  const createWatchers = (): vscode.Disposable[] => {
    const glob = vscode.workspace.getConfiguration('nestro').get<string>('monorepoGlob', '**/package.json');
    const folders = vscode.workspace.workspaceFolders ?? [];

    return folders.flatMap((folder) => {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, glob),
      );
      return [
        watcher,
        watcher.onDidChange(scheduleRefresh),
        watcher.onDidCreate(scheduleRefresh),
        watcher.onDidDelete(scheduleRefresh),
      ];
    });
  };

  let disposables = createWatchers();
  const controller = {
    refresh: (): void => {
      disposables.forEach(disposable => disposable.dispose());
      clearTimeout(debounceTimer);
      disposables = createWatchers();
    },
    dispose: (): void => {
      disposables.forEach(disposable => disposable.dispose());
      clearTimeout(debounceTimer);
    },
  };
  context.subscriptions.push(controller);
  return controller;
}

export function registerConfigurationWatcher(
  context: vscode.ExtensionContext,
  provider: Pick<PackagesProvider, 'invalidateUpdateCache' | 'loadPackages' | 'resetUpdateData' | 'setFilter'>,
  refreshPackageJsonWatcher?: () => void,
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
        || e.affectsConfiguration('nestro.minimumReleaseAgeDays')
      ) {
        provider.invalidateUpdateCache();
        provider.resetUpdateData();
      }
      if (e.affectsConfiguration('nestro.monorepoGlob')) {
        provider.invalidateUpdateCache();
        refreshPackageJsonWatcher?.();
        void provider.loadPackages();
      }
    }),
  );
}