import * as path from 'path';
import * as vscode from 'vscode';
import { ClientManager } from '../clients';
import {
  fetchAllLatestVersions,
  getPackageDirectory,
  getUpdateType,
  getWorkspacePackageFilePaths,
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

export interface PackageStateIdentity {
  packageName: string;
  packageFilePath: string;
  section: 'dependencies' | 'devDependencies';
}

export class PackagesProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000;

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly filterChangeDisposable: vscode.Disposable;
  private allEntries: PackageTreeEntry[] = [];
  private loading = true;
  private writeSuppressionDepth = 0;
  private readonly writeSuppressionTimers = new Set<ReturnType<typeof setTimeout>>();
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
    return this.writeSuppressionDepth > 0;
  }

  async withWriteSuppressed<T>(fn: () => Promise<T>): Promise<T> {
    this.writeSuppressionDepth += 1;
    try {
      const result = await fn();
      this.invalidateUpdateCache();
      return result;
    }
    finally {
      const timer = setTimeout(() => {
        this.writeSuppressionTimers.delete(timer);
        this.writeSuppressionDepth = Math.max(0, this.writeSuppressionDepth - 1);
      }, 600);
      this.writeSuppressionTimers.add(timer);
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

  markPackageUpdated(identity: PackageStateIdentity, newVersion: string): void {
    const index = this.findEntryIndex(identity);
    if (index === -1) {
      return;
    }

    const { dev, packageFilePath: entryPackageFilePath, item } = this.allEntries[index];
    this.allEntries[index] = {
      item: this.createPackageItem(
        identity.packageName,
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
    this.lastCheckTime = undefined;
    logger.info('Update cache invalidated.');
  }

  markPackageUpdating(identity: PackageStateIdentity, installing: boolean): void {
    const index = this.findEntryIndex(identity);
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
    this.auditResults = new Map();
    this.auditState = 'idle';
    this.lastAuditCount = undefined;
    this.emitTreeChanged();
    try {
      const entries = await readAllWorkspaceDependencies();
      logger.info(`Loaded ${entries.length} workspace package(s).`);
      const existingMap = new Map(this.allEntries.map(e => [this.entryKey(e.item.packageName, e.packageFilePath), e]));
      this.allEntries = entries.map((e) => {
        const existing = existingMap.get(this.entryKey(e.name, e.packageFilePath));
        // Compare bare semver (strip prefix) so that a pin operation (^1.2.3 → 1.2.3)
        // preserves existing update data rather than resetting it to 'none'.
        const existingSemver = existing?.item.currentVersion.slice(existing.item.versionPrefix.length);
        const newSemver = e.current.slice(e.versionPrefix.length);
        if (existing && existingSemver === newSemver) {
          return {
            item: this.createPackageItem(
              e.name,
              e.current,
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
    if (this.checkState === 'running') {
      return;
    }

    this.checkState = 'running';
    this.emitTreeChanged();
    try {
      const config = vscode.workspace.getConfiguration('nestro');
      const forceAlways = config.get<boolean>('checkUpdatesForceAlways', false);
      const includePreReleases = config.get<boolean>('includePreReleases', true);
      const target = config.get<NcuUpdateTarget>('updateTarget', 'latest');
      const source = this.allEntries.length > 0
        ? this.allEntries.map(e => ({
            name: e.item.packageName,
            current: e.item.currentVersion,
            dev: e.dev,
            versionPrefix: e.item.versionPrefix,
            packageFilePath: e.packageFilePath,
          }))
        : await readAllWorkspaceDependencies();
      const packageFiles = [...new Set(source.map(entry => entry.packageFilePath))];
      const packageFilesKey = this.packageFilesKey(packageFiles);
      const cacheValid = this.isCacheValid(target, includePreReleases, packageFilesKey);
      if (!forceAlways && cacheValid && this.lastCheckTime !== undefined) {
        const debounceSec = config.get<number>('checkUpdatesDebounce', 60);
        if (debounceSec > 0 && Date.now() - this.lastCheckTime.getTime() < debounceSec * 1000) {
          logger.info('Check for updates skipped — debounce interval has not elapsed.');
          this.checkState = 'done';
          return;
        }
      }
      logger.info('Checking package updates.');
      logger.info(`Checking updates for ${source.length} package(s).`);
      const upgrades = !forceAlways && cacheValid
        ? this.updateCache?.data ?? new Map<string, string>()
        : await this.fetchAndCacheUpdates(target, includePreReleases, packageFiles, packageFilesKey);
      const liveEntries = this.allEntries.length > 0
        ? this.allEntries
        : source.map(entry => ({
            item: this.createPackageItem(
              entry.name,
              entry.current,
              undefined,
              'none',
              false,
              entry.packageFilePath,
              entry.dev,
              entry.versionPrefix,
            ),
            dev: entry.dev,
            packageFilePath: entry.packageFilePath,
          }));
      this.allEntries = liveEntries.map(({ item, dev, packageFilePath }) => {
        const latest = upgrades.get(this.entryKey(item.packageName, packageFilePath));
        const updateType = latest === undefined ? 'none' : getUpdateType(item.currentVersion, latest);
        return {
          item: this.createPackageItem(
            item.packageName,
            item.currentVersion,
            latest,
            updateType,
            item.installing,
            packageFilePath,
            dev,
            item.versionPrefix,
          ),
          dev,
          packageFilePath,
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
    for (const timer of this.writeSuppressionTimers) {
      clearTimeout(timer);
    }
    this.writeSuppressionTimers.clear();
    this.writeSuppressionDepth = 0;
    this.filterChangeDisposable.dispose();
    this._onDidChangeTreeData.dispose();
  }

  async runAudit(): Promise<void> {
    if (this.auditState === 'running') {
      return;
    }

    this.auditState = 'running';
    this.emitTreeChanged();

    try {
      const packageFilePaths = await this.getKnownPackageFilePaths();
      if (packageFilePaths.length === 0) {
        this.auditState = 'idle';
        return;
      }

      const auditResults = new Map<string, AuditSeverity>();
      for (const packageFilePath of packageFilePaths) {
        const client = await this.clientManager.getClient(getPackageDirectory(packageFilePath));
        const fileResults = await client.runAudit();
        for (const [packageName, severity] of fileResults) {
          auditResults.set(this.entryKey(packageName, packageFilePath), severity);
        }
      }
      this.auditResults = auditResults;
      this.auditState = 'done';
      this.lastAuditCount = this.auditResults.size;
      logger.info(`Audit: ${this.auditResults.size} vulnerable package(s).`);
      this.rebuildPackageItems();
    }
    catch (err) {
      this.auditState = 'idle';
      showError(`package audit failed — ${err instanceof Error ? err.message : String(err)}`, err);
    }
    finally {
      this.emitTreeChanged();
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
      this.auditResults.get(this.entryKey(packageName, packageFilePath)),
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

  private async getKnownPackageFilePaths(): Promise<string[]> {
    const knownPackageFilePaths = [...new Set(this.allEntries.map(entry => entry.packageFilePath).filter(Boolean))];
    if (knownPackageFilePaths.length > 0) {
      return knownPackageFilePaths;
    }

    return await getWorkspacePackageFilePaths();
  }

  private entryKey(packageName: string, packageFilePath: string): string {
    return `${packageFilePath}\0${packageName}`;
  }

  private packageFilesKey(packageFiles: readonly string[]): string {
    return [...packageFiles].sort((a, b) => a.localeCompare(b)).join('\0');
  }

  private packageStateKey(identity: PackageStateIdentity): string {
    return `${identity.packageFilePath}\0${identity.packageName}\0${identity.section}`;
  }

  private findEntryIndex(identity: PackageStateIdentity): number {
    const key = this.packageStateKey(identity);
    return this.allEntries.findIndex(e => this.packageStateKey({
      packageName: e.item.packageName,
      packageFilePath: e.packageFilePath,
      section: e.dev ? 'devDependencies' : 'dependencies',
    }) === key);
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
    if (packageFilePath === '') {
      return undefined;
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(packageFilePath));
    if (workspaceFolder === undefined) {
      return packageFilePath;
    }

    const relativeFile = path.relative(workspaceFolder.uri.fsPath, packageFilePath).replace(/\\/g, '/');
    if (relativeFile === 'package.json') {
      return undefined;
    }

    return relativeFile;
  }
}