import * as vscode from 'vscode';
import {
  fetchAllLatestVersions,
  getUpdateType,
  getWorkspacePackageFilePath,
  logger,
  NcuUpdateTarget,
  readWorkspaceDependencies,
  runNpmAudit,
  showError,
} from '../utils';
import type { AuditSeverity, UpdateType } from '../utils';
import { LoadingItem } from './LoadingItem';
import { PackageItem } from './PackageItem';
import { GroupItem } from './GroupItem';
import { FilterManager, FilterType } from './FilterManager';
import { buildTree, getFilterCounts, getFilteredEntries, PackageTreeEntry } from './treeBuilder';

export class PackagesProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000;

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly filterChangeDisposable: vscode.Disposable;
  private allEntries: PackageTreeEntry[] = [];
  private loading = true;
  private isWriting = false;
  private treeView: vscode.TreeView<vscode.TreeItem> | undefined;
  private auditResults: Map<string, AuditSeverity> = new Map();
  private updateCache: {
    data: Map<string, string>;
    timestamp: number;
    target: NcuUpdateTarget;
    includePreReleases: boolean;
  } | undefined;

  constructor(private readonly filterManager: FilterManager) {
    this.filterChangeDisposable = this.filterManager.onDidChange(() => this.emitTreeChanged());
  }

  attachTreeView(treeView: vscode.TreeView<vscode.TreeItem>): void {
    this.treeView = treeView;
    this.updateTreeViewState();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (this.loading) {
      return element ? [] : [new LoadingItem()];
    }
    if (element instanceof GroupItem) {
      return element.children;
    }
    return buildTree(this.allEntries, this.filterManager.current);
  }

  setFilter(type: FilterType): void {
    this.filterManager.set(type);
  }

  get suppressingWrites(): boolean {
    return this.isWriting;
  }

  async withWriteSuppressed<T>(fn: () => Promise<T>): Promise<T> {
    this.isWriting = true;
    try {
      const result = await fn();
      this.invalidateUpdateCache();
      return result;
    }
    finally {
      setTimeout(() => {
        this.isWriting = false;
      }, 600);
    }
  }

  getVisibleOutdatedPackages(): PackageItem[] {
    if (this.loading) {
      return [];
    }
    return getFilteredEntries(this.allEntries, this.filterManager.current)
      .map(entry => entry.item)
      .filter(item => item.updateType !== 'none' && item.latest !== undefined && !item.installing);
  }

  markPackageUpdated(packageName: string, newVersion: string): void {
    const index = this.allEntries.findIndex(e => e.item.packageName === packageName);
    if (index === -1) {
      return;
    }

    const { dev } = this.allEntries[index];
    this.allEntries[index] = {
      item: this.createPackageItem(packageName, newVersion, undefined, 'none'),
      dev,
    };
    this.emitTreeChanged();
  }

  resetUpdateData(): void {
    this.invalidateUpdateCache();
    this.allEntries = this.allEntries.map(({ item, dev }) => ({
      item: this.createPackageItem(item.packageName, item.currentVersion, undefined, 'none'),
      dev,
    }));
    this.emitTreeChanged();
  }

  invalidateUpdateCache(): void {
    this.updateCache = undefined;
    logger.info('Update cache invalidated.');
  }

  markPackageUpdating(packageName: string, installing: boolean): void {
    const index = this.allEntries.findIndex(e => e.item.packageName === packageName);
    if (index === -1) {
      return;
    }

    const { item, dev } = this.allEntries[index];
    this.allEntries[index] = {
      item: this.createPackageItem(item.packageName, item.currentVersion, item.latest, item.updateType, installing),
      dev,
    };
    this.emitTreeChanged();
  }

  async showFilterPicker(): Promise<void> {
    if (this.allEntries.length === 0) {
      return;
    }
    await this.filterManager.showPicker(getFilterCounts(this.allEntries));
  }

  async loadPackages(): Promise<void> {
    logger.info('Loading workspace packages.');
    this.loading = true;
    this.emitTreeChanged();
    try {
      const entries = await readWorkspaceDependencies();
      logger.info(`Loaded ${entries.length} workspace package(s).`);
      const existingMap = new Map(this.allEntries.map(e => [e.item.packageName, e]));
      this.allEntries = entries.map((e) => {
        const existing = existingMap.get(e.name);
        if (existing && existing.item.currentVersion === e.current) {
          return {
            item: this.createPackageItem(
              existing.item.packageName,
              existing.item.currentVersion,
              existing.item.latest,
              existing.item.updateType,
              existing.item.installing,
            ),
            dev: e.dev,
          };
        }
        return { item: this.createPackageItem(e.name, e.current, undefined, 'none'), dev: e.dev };
      });
    }
    catch (err) {
      showError(`failed to load packages — ${err instanceof Error ? err.message : String(err)}`, err);
    }
    finally {
      this.loading = false;
      this.emitTreeChanged();
    }
  }

  async checkUpdates(): Promise<void> {
    logger.info('Checking package updates.');
    try {
      const includePreReleases = vscode.workspace
        .getConfiguration('nestro')
        .get<boolean>('includePreReleases', true);
      const target = vscode.workspace
        .getConfiguration('nestro')
        .get<NcuUpdateTarget>('updateTarget', 'latest');
      const source = this.allEntries.length > 0
        ? this.allEntries.map(e => ({ name: e.item.packageName, current: e.item.currentVersion, dev: e.dev }))
        : await readWorkspaceDependencies();
      logger.info(`Checking updates for ${source.length} package(s).`);
      const upgrades = this.isCacheValid(target, includePreReleases)
        ? this.updateCache?.data ?? new Map<string, string>()
        : await this.fetchAndCacheUpdates(target, includePreReleases);
      this.allEntries = source.map((entry) => {
        const latest = upgrades.get(entry.name);
        const updateType = latest === undefined ? 'none' : getUpdateType(entry.current, latest);
        return { item: this.createPackageItem(entry.name, entry.current, latest, updateType), dev: entry.dev };
      });
      logger.info(`Checked updates for ${source.length} package(s).`);
    }
    catch (err) {
      showError(`failed to check updates — ${err instanceof Error ? err.message : String(err)}`, err);
    }
    finally {
      this.loading = false;
      this.emitTreeChanged();
    }
  }

  dispose(): void {
    this.filterChangeDisposable.dispose();
    this._onDidChangeTreeData.dispose();
  }

  async runAudit(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder === undefined) {
      return;
    }

    try {
      const result = await runNpmAudit(folder.uri.fsPath);
      this.auditResults = result.vulnerabilities;
      logger.info(`Audit: ${result.total} vulnerable package(s).`);
      this.rebuildPackageItems();
      this.emitTreeChanged();
    }
    catch (err) {
      showError(`npm audit failed — ${err instanceof Error ? err.message : String(err)}`, err);
    }
  }

  private emitTreeChanged(): void {
    this.updateTreeViewState();
    void vscode.commands.executeCommand(
      'setContext',
      'nestro.canUpdateVisiblePackages',
      this.getVisibleOutdatedPackages().length > 0,
    );
    void vscode.commands.executeCommand(
      'setContext',
      'nestro.noWorkspace',
      !this.loading && this.allEntries.length === 0,
    );
    this._onDidChangeTreeData.fire();
  }

  private createPackageItem(
    packageName: string,
    currentVersion: string,
    latest: string | undefined,
    updateType: UpdateType,
    installing = false,
  ): PackageItem {
    return new PackageItem(
      packageName,
      currentVersion,
      latest,
      updateType,
      installing,
      this.auditResults.get(packageName),
    );
  }

  private rebuildPackageItems(): void {
    this.allEntries = this.allEntries.map(({ item, dev }) => ({
      item: this.createPackageItem(
        item.packageName,
        item.currentVersion,
        item.latest,
        item.updateType,
        item.installing,
      ),
      dev,
    }));
  }

  private updateTreeViewState(): void {
    if (this.treeView === undefined) {
      return;
    }

    const outdatedCount = this.allEntries.filter(e => (
      e.item.updateType !== 'none'
      && e.item.latest !== undefined
      && !e.item.installing
    )).length;
    this.treeView.badge = outdatedCount > 0
      ? { tooltip: `${outdatedCount} package updates available`, value: outdatedCount }
      : undefined;
    this.treeView.message = undefined;
  }

  private isCacheValid(target: NcuUpdateTarget, includePreReleases: boolean): boolean {
    if (this.updateCache === undefined) {
      return false;
    }
    if (this.updateCache.target !== target) {
      return false;
    }
    if (this.updateCache.includePreReleases !== includePreReleases) {
      return false;
    }
    return Date.now() - this.updateCache.timestamp < PackagesProvider.CACHE_TTL_MS;
  }

  private async fetchAndCacheUpdates(
    target: NcuUpdateTarget,
    includePreReleases: boolean,
  ): Promise<Map<string, string>> {
    this.loading = true;
    this.emitTreeChanged();
    const packageFilePath = getWorkspacePackageFilePath();
    const upgrades = packageFilePath === undefined
      ? new Map<string, string>()
      : await fetchAllLatestVersions(packageFilePath, target, includePreReleases);
    this.updateCache = {
      data: upgrades,
      timestamp: Date.now(),
      target,
      includePreReleases,
    };
    return upgrades;
  }
}