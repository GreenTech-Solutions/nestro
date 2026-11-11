import * as vscode from 'vscode';
import { getCheckUpdatesOnStartup, getDefaultFilter, getMonorepoGlob, getRunAuditOnStartup, PACKAGE_JSON_WATCHER_DEBOUNCE_MS } from './config';
import { FilterManager, isFilterType, PackagesProvider } from './providers';
import {
  copyPackageNameCommand,
  installUpdateCommand,
  openAuditReportCommand,
  openOnNpmCommand,
  openStatusReportCommand,
  pickVersionCommand,
  pinAllVersionsCommand,
  pinVersionCommand,
  removePackageCommand,
  runInstallCommand,
  switchDepTypeCommand,
  updateAllVisibleCommand,
} from './commands';
import { logger } from './utils';
import { COMMAND_IDS, VIEW_IDS } from './shared';

export function activate(context: vscode.ExtensionContext): void {
  logger.info('Extension activated.');

  const filterManager = new FilterManager(getDefaultFilter());
  const provider = new PackagesProvider(filterManager);
  const auditReportOutput = vscode.window.createOutputChannel(vscode.l10n.t('Nestro Security Audit'));
  const statusReportOutput = vscode.window.createOutputChannel(vscode.l10n.t('Nestro Diagnostics'));
  const treeView = vscode.window.createTreeView(VIEW_IDS.packages, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  provider.attachTreeView(treeView);
  const checkUpdatesOnStartup = getCheckUpdatesOnStartup();
  const runAuditOnStartup = getRunAuditOnStartup();

  registerExtensionCommands(context, filterManager, provider, treeView, auditReportOutput, statusReportOutput);

  const packageJsonWatcher = registerPackageJsonWatcher(context, provider);
  registerConfigurationWatcher(context, provider, () => packageJsonWatcher.refresh());
  registerWorkspaceFoldersWatcher(context, provider, () => packageJsonWatcher.refresh());

  void provider.loadPackages();
  if (checkUpdatesOnStartup) {
    void provider.checkUpdates();
  }
  if (runAuditOnStartup) {
    void provider.runAudit();
  }
}

function registerExtensionCommands(
  context: vscode.ExtensionContext,
  filterManager: FilterManager,
  provider: PackagesProvider,
  treeView: vscode.Disposable,
  auditReportOutput: vscode.OutputChannel,
  statusReportOutput: vscode.OutputChannel,
): void {
  context.subscriptions.push(
    treeView,
    vscode.commands.registerCommand(COMMAND_IDS.refresh, () => { void provider.loadPackages(); }),
    vscode.commands.registerCommand(COMMAND_IDS.checkUpdates, () => { void provider.checkUpdates(); }),
    vscode.commands.registerCommand(COMMAND_IDS.runAudit, () => { void provider.runAudit(); }),
    auditReportOutput,
    vscode.commands.registerCommand(COMMAND_IDS.openAuditReport, () => {
      openAuditReportCommand(provider, auditReportOutput);
    }),
    statusReportOutput,
    vscode.commands.registerCommand(COMMAND_IDS.openStatusReport, () => {
      openStatusReportCommand(provider, statusReportOutput);
    }),
    vscode.commands.registerCommand(COMMAND_IDS.installUpdate, (item: unknown) => { void installUpdateCommand(item, provider); }),
    vscode.commands.registerCommand(COMMAND_IDS.pickVersion, (item: unknown) => { void pickVersionCommand(item, provider); }),
    vscode.commands.registerCommand(COMMAND_IDS.switchDepType, (item: unknown) => { void switchDepTypeCommand(item, provider); }),
    vscode.commands.registerCommand(COMMAND_IDS.pinVersion, (item: unknown) => { void pinVersionCommand(item, provider); }),
    vscode.commands.registerCommand(COMMAND_IDS.removePackage, (item: unknown) => { void removePackageCommand(item, provider); }),
    vscode.commands.registerCommand(COMMAND_IDS.runInstall, () => { void runInstallCommand(provider); }),
    vscode.commands.registerCommand(COMMAND_IDS.updateAllVisible, () => { void updateAllVisibleCommand(provider); }),
    vscode.commands.registerCommand(COMMAND_IDS.pinAllVersions, () => { void pinAllVersionsCommand(provider); }),
    vscode.commands.registerCommand(COMMAND_IDS.openOnNpm, (item: unknown) => { openOnNpmCommand(item); }),
    vscode.commands.registerCommand(COMMAND_IDS.copyPackageName, (item: unknown) => { copyPackageNameCommand(item); }),
    vscode.commands.registerCommand(COMMAND_IDS.setFilter, (type: unknown) => {
      if (!isFilterType(type)) {
        return;
      }
      provider.setFilter(type);
    }),
    vscode.commands.registerCommand(COMMAND_IDS.showFilterPicker, () => { void provider.showFilterPicker(); }),
    vscode.commands.registerCommand(COMMAND_IDS.searchPackages, () => { void provider.showSearch(); }),
    vscode.commands.registerCommand(COMMAND_IDS.clearSearchQuery, () => { provider.clearSearch(); }),
    vscode.commands.registerCommand(COMMAND_IDS.openSettings, () => {
      void vscode.commands.executeCommand('workbench.action.openSettings', 'nestro');
    }),
    logger,
    filterManager,
    provider,
  );
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

export function registerPackageJsonWatcher(
  context: vscode.ExtensionContext,
  provider: Pick<PackagesProvider, 'invalidateUpdateCache' | 'loadPackages' | 'isOwnManifestWrite'>,
): vscode.Disposable & { refresh(): void } {
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingChanges = new Map<string, vscode.Uri>();

  const refreshIfExternalChange = async (): Promise<void> => {
    const changedFiles = [...pendingChanges.values()];
    pendingChanges.clear();
    const ownWrites = await Promise.all(changedFiles.map(uri => provider.isOwnManifestWrite(uri)));
    if (ownWrites.every(Boolean)) {
      return;
    }
    provider.invalidateUpdateCache();
    void provider.loadPackages();
  };

  const scheduleRefresh = (uri: vscode.Uri): void => {
    pendingChanges.set(uri.fsPath, uri);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void refreshIfExternalChange();
    }, PACKAGE_JSON_WATCHER_DEBOUNCE_MS);
  };

  const createWatchers = (): vscode.Disposable[] => {
    const glob = getMonorepoGlob();
    const folders = vscode.workspace.workspaceFolders ?? [];
    return folders.flatMap((folder) => {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, glob));
      return [
        watcher,
        watcher.onDidChange(scheduleRefresh),
        watcher.onDidCreate(scheduleRefresh),
        watcher.onDidDelete(scheduleRefresh),
      ];
    });
  };

  let disposables = createWatchers();
  const controller: vscode.Disposable & { refresh(): void } = {
    refresh: () => {
      disposables.forEach(disposable => disposable.dispose());
      clearTimeout(debounceTimer);
      pendingChanges.clear();
      disposables = createWatchers();
    },
    dispose: () => {
      disposables.forEach(disposable => disposable.dispose());
      clearTimeout(debounceTimer);
      pendingChanges.clear();
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
        provider.setFilter(getDefaultFilter());
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