import * as vscode from 'vscode';
import {
  fetchAllLatestVersions,
  getUpdateType,
  getWorkspacePackageFilePath,
  logger,
  NcuUpdateTarget,
  readWorkspaceDependencies,
  showError,
} from '../utils';
import { LoadingItem } from './LoadingItem';
import { PackageItem } from './PackageItem';
import { GroupItem } from './GroupItem';
import { FilterManager, FilterType } from './FilterManager';
import { buildTree, getFilterCounts, getFilteredEntries, PackageTreeEntry } from './treeBuilder';

export class PackagesProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly filterChangeDisposable: vscode.Disposable;
  private allEntries: PackageTreeEntry[] = [];
  private loading = true;
  private treeView: vscode.TreeView<vscode.TreeItem> | undefined;

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
      item: new PackageItem(packageName, newVersion, undefined, 'none'),
      dev,
    };
    this.emitTreeChanged();
  }

  markPackageUpdating(packageName: string, installing: boolean): void {
    const index = this.allEntries.findIndex(e => e.item.packageName === packageName);
    if (index === -1) {
      return;
    }

    const { item, dev } = this.allEntries[index];
    this.allEntries[index] = {
      item: new PackageItem(item.packageName, item.currentVersion, item.latest, item.updateType, installing),
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
          return { item: existing.item, dev: e.dev };
        }
        return { item: new PackageItem(e.name, e.current, undefined, 'none'), dev: e.dev };
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
    this.loading = true;
    this.emitTreeChanged();
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
      const packageFilePath = getWorkspacePackageFilePath();
      const upgrades = packageFilePath === undefined
        ? new Map<string, string>()
        : await fetchAllLatestVersions(packageFilePath, target, includePreReleases);
      this.allEntries = source.map((entry) => {
        const latest = upgrades.get(entry.name);
        const updateType = latest === undefined ? 'none' : getUpdateType(entry.current, latest);
        return { item: new PackageItem(entry.name, entry.current, latest, updateType), dev: entry.dev };
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
}