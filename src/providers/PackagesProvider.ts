import * as vscode from 'vscode';
import { ClientManager } from '../clients';
import {
  fetchAllLatestVersions,
  getUpdateType,
  logger,
  NcuUpdateTarget,
  readAllWorkspaceDependencies,
  showError,
} from '../utils';
import type { AuditSeverity, UpdateType } from '../utils';
import { LoadingItem } from './LoadingItem';
import { PackageItem } from './PackageItem';
import { PackageDetailItem } from './PackageDetailItem';
import { GroupItem } from './GroupItem';
import { StatusItem } from './StatusItem';
import { FilterManager, FilterType } from './FilterManager';
import { buildTree, getFilterCounts, getFilteredEntries, PackageTreeEntry } from './treeBuilder';
import { WorkspaceFolderItem } from './WorkspaceFolderItem';

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
  private checkState: 'idle' | 'running' | 'done' = 'idle';
  private lastCheckTime: Date | undefined;
  private auditState: 'idle' | 'running' | 'done' = 'idle';
  private lastAuditCount: number | undefined;
  private readonly clientManager = new ClientManager();
  private updateCache: {
    data: Map<string, string>;
    timestamp: number;
    target: NcuUpdateTarget;
    includePreReleases: boolean;
    packageFilesKey: string;
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
      return element ? [] : [...this.buildStatusItems(), new LoadingItem()];
    }
    if (element instanceof GroupItem) {
      return element.children;
    }
    if (element instanceof StatusItem) {
      return [];
    }
    if (element instanceof WorkspaceFolderItem) {
      return element.children;
    }
    if (element instanceof PackageItem) {
      return this.getPackageDetails(element);
    }
    return [...this.buildStatusItems(), ...buildTree(
      this.allEntries,
      this.filterManager.current,
      this.filterManager.search,
      this.workspaceRoot,
    )];
  }

  setFilter(type: FilterType): void {
    this.filterManager.set(type);
  }

  async showSearch(): Promise<void> {
    await this.filterManager.showSearch();
  }

  clearSearch(): void {
    this.filterManager.clearSearch();
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
    return getFilteredEntries(this.allEntries, this.filterManager.current, this.filterManager.search)
      .map(entry => entry.item)
      .filter(item => item.updateType !== 'none' && item.latest !== undefined && !item.installing);
  }

  markPackageUpdated(packageName: string, newVersion: string, packageFilePath?: string): void {
    const index = this.findEntryIndex(packageName, packageFilePath);
    if (index === -1) {
      return;
    }

    const { dev, packageFilePath: entryPackageFilePath, item } = this.allEntries[index];
    this.allEntries[index] = {
      item: this.createPackageItem(
        packageName,
        item.versionPrefix + newVersion,
        undefined,
        'none',
        false,
        entryPackageFilePath,
        dev,
        item.versionPrefix,
      ),
      dev,
      packageFilePath: entryPackageFilePath,
    };
    this.emitTreeChanged();
  }

  resetUpdateData(): void {
    this.invalidateUpdateCache();
    this.allEntries = this.allEntries.map(({ item, dev, packageFilePath }) => ({
      item: this.createPackageItem(
        item.packageName,
        item.currentVersion,
        undefined,
        'none',
        false,
        packageFilePath,
        dev,
        item.versionPrefix,
      ),
      dev,
      packageFilePath,
    }));
    this.emitTreeChanged();
  }

  invalidateUpdateCache(): void {
    this.updateCache = undefined;
    logger.info('Update cache invalidated.');
  }

  markPackageUpdating(packageName: string, installing: boolean, packageFilePath?: string): void {
    const index = this.findEntryIndex(packageName, packageFilePath);
    if (index === -1) {
      return;
    }

    const { item, dev, packageFilePath: entryPackageFilePath } = this.allEntries[index];
    this.allEntries[index] = {
      item: this.createPackageItem(
        item.packageName,
        item.currentVersion,
        item.latest,
        item.updateType,
        installing,
        entryPackageFilePath,
        dev,
        item.versionPrefix,
      ),
      dev,
      packageFilePath: entryPackageFilePath,
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
      const entries = await readAllWorkspaceDependencies();
      logger.info(`Loaded ${entries.length} workspace package(s).`);
      const existingMap = new Map(this.allEntries.map(e => [this.entryKey(e.item.packageName, e.packageFilePath), e]));
      this.allEntries = entries.map((e) => {
        const existing = existingMap.get(this.entryKey(e.name, e.packageFilePath));
        if (existing && existing.item.currentVersion === e.current) {
          return {
            item: this.createPackageItem(
              existing.item.packageName,
              existing.item.currentVersion,
              existing.item.latest,
              existing.item.updateType,
              existing.item.installing,
              e.packageFilePath,
              e.dev,
              e.versionPrefix,
            ),
            dev: e.dev,
            packageFilePath: e.packageFilePath,
          };
        }
        return {
          item: this.createPackageItem(e.name, e.current, undefined, 'none', false, e.packageFilePath, e.dev, e.versionPrefix),
          dev: e.dev,
          packageFilePath: e.packageFilePath,
        };
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
    this.checkState = 'running';
    this.emitTreeChanged();
    try {
      const includePreReleases = vscode.workspace
        .getConfiguration('nestro')
        .get<boolean>('includePreReleases', true);
      const target = vscode.workspace
        .getConfiguration('nestro')
        .get<NcuUpdateTarget>('updateTarget', 'latest');
      const source = this.allEntries.length > 0
        ? this.allEntries.map(e => ({
            name: e.item.packageName,
            current: e.item.currentVersion,
            dev: e.dev,
            versionPrefix: e.item.versionPrefix,
            packageFilePath: e.packageFilePath,
          }))
        : await readAllWorkspaceDependencies();
      logger.info(`Checking updates for ${source.length} package(s).`);
      const packageFiles = [...new Set(source.map(entry => entry.packageFilePath))];
      const packageFilesKey = this.packageFilesKey(packageFiles);
      const upgrades = this.isCacheValid(target, includePreReleases, packageFilesKey)
        ? this.updateCache?.data ?? new Map<string, string>()
        : await this.fetchAndCacheUpdates(target, includePreReleases, packageFiles, packageFilesKey);
      this.allEntries = source.map((entry) => {
        const latest = upgrades.get(this.entryKey(entry.name, entry.packageFilePath));
        const updateType = latest === undefined ? 'none' : getUpdateType(entry.current, latest);
        return {
          item: this.createPackageItem(
            entry.name,
            entry.current,
            latest,
            updateType,
            false,
            entry.packageFilePath,
            entry.dev,
            entry.versionPrefix,
          ),
          dev: entry.dev,
          packageFilePath: entry.packageFilePath,
        };
      });
      logger.info(`Checked updates for ${source.length} package(s).`);
      this.checkState = 'done';
      this.lastCheckTime = new Date();
    }
    catch (err) {
      this.checkState = 'idle';
      showError(`failed to check updates — ${err instanceof Error ? err.message : String(err)}`, err);
    }
    finally {
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

    this.auditState = 'running';
    this.emitTreeChanged();
    try {
      const client = await this.clientManager.getClient(folder.uri.fsPath);
      this.auditResults = await client.runAudit();
      this.auditState = 'done';
      this.lastAuditCount = this.auditResults.size;
      logger.info(`Audit: ${this.auditResults.size} vulnerable package(s).`);
      this.rebuildPackageItems();
      this.emitTreeChanged();
    }
    catch (err) {
      this.auditState = 'idle';
      showError(`package audit failed — ${err instanceof Error ? err.message : String(err)}`, err);
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
    packageFilePath = '',
    dev = false,
    versionPrefix = '',
  ): PackageItem {
    return new PackageItem(
      packageName,
      currentVersion,
      latest,
      updateType,
      installing,
      this.auditResults.get(packageName),
      packageFilePath,
      dev,
      versionPrefix,
    );
  }

  private rebuildPackageItems(): void {
    this.allEntries = this.allEntries.map(({ item, dev, packageFilePath }) => ({
      item: this.createPackageItem(
        item.packageName,
        item.currentVersion,
        item.latest,
        item.updateType,
        item.installing,
        packageFilePath,
        dev,
        item.versionPrefix,
      ),
      dev,
      packageFilePath,
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

  private isCacheValid(target: NcuUpdateTarget, includePreReleases: boolean, packageFilesKey: string): boolean {
    if (this.updateCache === undefined) {
      return false;
    }
    if (this.updateCache.target !== target) {
      return false;
    }
    if (this.updateCache.includePreReleases !== includePreReleases) {
      return false;
    }
    if (this.updateCache.packageFilesKey !== packageFilesKey) {
      return false;
    }
    return Date.now() - this.updateCache.timestamp < PackagesProvider.CACHE_TTL_MS;
  }

  private async fetchAndCacheUpdates(
    target: NcuUpdateTarget,
    includePreReleases: boolean,
    packageFiles: readonly string[],
    packageFilesKey: string,
  ): Promise<Map<string, string>> {
    const upgrades = new Map<string, string>();
    for (const packageFilePath of packageFiles) {
      const fileUpgrades = await fetchAllLatestVersions(packageFilePath, target, includePreReleases);
      for (const [packageName, version] of fileUpgrades) {
        upgrades.set(this.entryKey(packageName, packageFilePath), version);
      }
    }
    this.updateCache = {
      data: upgrades,
      timestamp: Date.now(),
      target,
      includePreReleases,
      packageFilesKey,
    };
    return upgrades;
  }

  private get workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private entryKey(packageName: string, packageFilePath: string): string {
    return `${packageFilePath}\0${packageName}`;
  }

  private packageFilesKey(packageFiles: readonly string[]): string {
    return [...packageFiles].sort((a, b) => a.localeCompare(b)).join('\0');
  }

  private findEntryIndex(packageName: string, packageFilePath: string | undefined): number {
    return this.allEntries.findIndex(e => (
      e.item.packageName === packageName
      && (packageFilePath === undefined || e.packageFilePath === packageFilePath)
    ));
  }

  private getPackageDetails(item: PackageItem): vscode.TreeItem[] {
    const details = [
      new PackageDetailItem(item.dev ? 'Dev dependency' : 'Dependency', item.dev ? 'tools' : 'package'),
      new PackageDetailItem(`Current: ${item.currentVersion}`, 'tag'),
    ];
    if (item.latest !== undefined) {
      details.push(new PackageDetailItem(`Update: ${item.currentVersion} → ${item.latest} (${item.updateType})`, 'arrow-up'));
    }
    if (item.vulnerabilitySeverity !== undefined) {
      details.push(new PackageDetailItem(`Vulnerability: ${item.vulnerabilitySeverity}`, 'warning'));
    }
    if (this.workspaceRoot !== undefined) {
      const relativeFile = this.toRelativePackageFilePath(item.packageFilePath);
      if (relativeFile !== undefined) {
        details.push(new PackageDetailItem(`File: ${relativeFile}`, 'file'));
      }
    }
    return details;
  }

  private buildStatusItems(): StatusItem[] {
    const items: StatusItem[] = [];

    if (this.checkState === 'running') {
      items.push(new StatusItem('Checking updates…', '', 'loading~spin'));
    }
    else if (this.checkState === 'done' && this.lastCheckTime !== undefined) {
      items.push(new StatusItem(
        'Last update check',
        this.lastCheckTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        'clock',
      ));
    }

    if (this.auditState === 'running') {
      items.push(new StatusItem('Running audit…', '', 'loading~spin'));
    }
    else if (this.auditState === 'done') {
      const count = this.lastAuditCount ?? 0;
      items.push(new StatusItem(
        'Audit complete',
        count === 0 ? 'No vulnerabilities' : `${count} vulnerable package(s)`,
        count === 0 ? 'shield-check' : 'warning',
        count === 0 ? 'charts.green' : 'charts.red',
      ));
    }

    return items;
  }

  private toRelativePackageFilePath(packageFilePath: string): string | undefined {
    const workspaceRoot = this.workspaceRoot;
    if (workspaceRoot === undefined || packageFilePath === '') {
      return undefined;
    }
    const normalizedFile = packageFilePath.replace(/\\/g, '/');
    const normalizedRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '');
    if (normalizedFile === `${normalizedRoot}/package.json`) {
      return undefined;
    }
    if (normalizedFile.startsWith(`${normalizedRoot}/`)) {
      return normalizedFile.slice(normalizedRoot.length + 1);
    }
    return packageFilePath;
  }
}