import * as vscode from 'vscode';
import { PACKAGE_PRESENTATION } from '../shared';
import { formatAuditSeverityLabel, formatUpdateTypeLabel } from '../utils';
import { FilterManager } from './FilterManager';
import { GroupItem } from './GroupItem';
import { LoadingItem } from './LoadingItem';
import { PackageDetailItem } from './PackageDetailItem';
import { PackageItem } from './PackageItem';
import { sanitizePackageText } from './packageItemPresentation';
import { StatusItem } from './StatusItem';
import { WorkspaceFolderItem } from './WorkspaceFolderItem';
import type { PackageProviderState } from './packageProviderState';
import {
  computeViewProjection,
  createAllFalseViewContexts,
  diffViewContexts,
  projectStatusRows,
  VIEW_CONTEXT_KEYS,
} from './viewProjectionService';
import type { ViewContextKey, ViewContextMap, ViewProjection, ViewProjectionSnapshot } from './viewProjectionService';
import { buildTree } from './treeBuilder';
import { getLocalizedPackageLabelFormatting, resolvePackageFileLabels } from './packageLabels';

/** Owns tree projection, status rows, and VS Code context publication. */
export class PackageViewController implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event;
  private treeView: vscode.TreeView<vscode.TreeItem> | undefined;
  private lastPublishedContexts: ViewContextMap | undefined;

  constructor(
    private readonly state: PackageProviderState,
    private readonly filterManager: FilterManager,
  ) {}

  attachTreeView(treeView: vscode.TreeView<vscode.TreeItem>): void {
    this.treeView = treeView;
    this.applyTreeViewState(computeViewProjection(this.buildViewProjectionSnapshot()));
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (this.state.loading) {
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
      this.state.rowStore.allEntries,
      this.filterManager.current,
      this.filterManager.search,
      this.state.workspaceFolderDescriptors,
      this.state.packageFilePaths,
    )];
  }

  emitTreeChanged(): void {
    if (this.state.disposed) {
      return;
    }
    if (
      this.filterManager.current === 'vulnerable'
      && this.state.auditState !== 'done'
      && this.state.auditState !== 'incomplete'
    ) {
      this.filterManager.set('all');
      return;
    }
    const projection = computeViewProjection(this.buildViewProjectionSnapshot());
    this.applyTreeViewState(projection);
    this.publishViewContexts(projection.contexts);
    this.onDidChangeEmitter.fire();
  }

  resetContexts(): void {
    const allFalse = createAllFalseViewContexts();
    for (const [key, value] of Object.entries(allFalse) as [ViewContextKey, boolean][]) {
      void vscode.commands.executeCommand('setContext', VIEW_CONTEXT_KEYS[key], value);
    }
    this.lastPublishedContexts = allFalse;
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }

  private buildViewProjectionSnapshot(): ViewProjectionSnapshot {
    return {
      entries: this.state.allEntries,
      filterType: this.filterManager.current,
      search: this.filterManager.search,
      loading: this.state.loading,
      workspaceCapabilities: this.state.workspaceCapabilities,
      capabilitiesInitialized: this.state.capabilitiesInitialized,
      packageReadFailed: this.state.packageReadFailed,
      packageReadFailures: this.state.packageReadFailures,
      checkState: this.state.checkState,
      lastCheckTime: this.state.lastCheckTime,
      failedUpdatePaths: this.state.failedUpdatePaths,
      auditState: this.state.auditState,
      lastAuditCount: this.state.lastAuditCount,
      lastAuditSuccessfulRootCount: this.state.lastAuditSuccessfulRootCount,
      failedAuditPaths: this.state.failedAuditPaths,
    };
  }

  private applyTreeViewState(projection: ViewProjection): void {
    if (this.treeView === undefined) {
      return;
    }
    this.treeView.badge = projection.badge;
    this.treeView.message = undefined;
    this.treeView.description = projection.description;
  }

  private publishViewContexts(next: ViewContextMap): void {
    const changed = diffViewContexts(this.lastPublishedContexts, next);
    for (const key of Object.keys(changed) as ViewContextKey[]) {
      void vscode.commands.executeCommand('setContext', VIEW_CONTEXT_KEYS[key], changed[key]);
    }
    this.lastPublishedContexts = next;
  }

  private buildStatusItems(): StatusItem[] {
    return projectStatusRows(this.buildViewProjectionSnapshot()).map(row => new StatusItem(
      row.label,
      row.description,
      row.icon,
      row.color,
      row.actionable,
      row.command,
      row.contextValue,
    ));
  }

  private getPackageDetails(item: PackageItem): vscode.TreeItem[] {
    const details = [
      new PackageDetailItem(
        item.dev ? vscode.l10n.t('Dev dependency') : vscode.l10n.t('Dependency'),
        item.dev
          ? PACKAGE_PRESENTATION.dependencyIcons.devDependencies
          : PACKAGE_PRESENTATION.dependencyIcons.dependencies,
      ),
      new PackageDetailItem(vscode.l10n.t('Current: {0}', sanitizePackageText(item.currentVersion)), 'tag'),
    ];
    if (item.latest !== undefined) {
      details.push(new PackageDetailItem(vscode.l10n.t(
        'Update: {0} → {1} ({2})',
        sanitizePackageText(item.currentVersion),
        sanitizePackageText(item.latest),
        formatUpdateTypeLabel(item.updateType),
      ), 'arrow-up'));
    }
    if (item.vulnerabilitySeverity !== undefined) {
      details.push(new PackageDetailItem(vscode.l10n.t(
        'Vulnerability: {0}',
        formatAuditSeverityLabel(item.vulnerabilitySeverity),
      ), 'warning'));
    }
    if (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath !== undefined) {
      const relativeFile = item.packageFilePath === ''
        ? undefined
        : resolvePackageFileLabels(
          [item.packageFilePath],
          this.state.workspaceFolderDescriptors,
          getLocalizedPackageLabelFormatting(),
        )[0]?.relativePackageFilePath ?? item.packageFilePath;
      if (relativeFile !== undefined && relativeFile !== 'package.json') {
        details.push(new PackageDetailItem(vscode.l10n.t('File: {0}', sanitizePackageText(relativeFile)), 'file'));
      }
    }
    return details;
  }
}