import * as vscode from 'vscode';
import { readWorkspaceDependencies, fetchLatestVersion, getUpdateType, showError } from '../utils';
import { LoadingItem } from './LoadingItem';
import { PackageItem } from './PackageItem';
import { GroupItem } from './GroupItem';
import { createFilterQuickPickItems, FilterBarItem, FilterCounts, FilterType } from './FilterBarItem';

export class PackagesProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private allEntries: { item: PackageItem; dev: boolean }[] = [];
    private loading = false;
    private filterType: FilterType = 'all';

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
        return [...buildFilterBar(this.allEntries, this.filterType), ...buildGroups(this.allEntries, this.filterType)];
    }

    setFilter(type: FilterType): void {
        this.filterType = type;
        this._onDidChangeTreeData.fire();
    }

    async showFilterPicker(): Promise<void> {
        if (this.allEntries.length === 0) {
            return;
        }
        const selected = await vscode.window.showQuickPick(
            createFilterQuickPickItems(getFilterCounts(this.allEntries), this.filterType),
            { placeHolder: 'Select package filter' },
        );
        if (selected) {
            this.setFilter(selected.filterType);
        }
    }

    async loadPackages(): Promise<void> {
        this.loading = true;
        this._onDidChangeTreeData.fire();
        try {
            const entries = await readWorkspaceDependencies();
            this.allEntries = entries.map((e) => ({
                item: new PackageItem(e.name, e.current, undefined, 'none'),
                dev: e.dev,
            }));
        } catch (err) {
            showError(`failed to load packages — ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            this.loading = false;
            this._onDidChangeTreeData.fire();
        }
    }

    async checkUpdates(): Promise<void> {
        this.loading = true;
        this._onDidChangeTreeData.fire();
        try {
            const includePreReleases = vscode.workspace
                .getConfiguration('nestro')
                .get<boolean>('includePreReleases', true);
            const entries = await readWorkspaceDependencies();
            this.allEntries = await Promise.all(
                entries.map(async (entry) => {
                    try {
                        const latest = await fetchLatestVersion(entry.name, includePreReleases);
                        const updateType = getUpdateType(entry.current, latest);
                        return { item: new PackageItem(entry.name, entry.current, latest, updateType), dev: entry.dev };
                    } catch {
                        return { item: new PackageItem(entry.name, entry.current, undefined, 'none'), dev: entry.dev };
                    }
                }),
            );
        } catch (err) {
            showError(`failed to check updates — ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            this.loading = false;
            this._onDidChangeTreeData.fire();
        }
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}

function buildFilterBar(
    entries: { item: PackageItem; dev: boolean }[],
    activeFilter: FilterType,
): FilterBarItem[] {
    if (entries.length === 0) {
        return [];
    }
    return [new FilterBarItem(getFilterCounts(entries), activeFilter)];
}

function getFilterCounts(entries: { item: PackageItem; dev: boolean }[]): FilterCounts {
    return {
        all:      entries.length,
        patch:    entries.filter((e) => e.item.updateType === 'patch').length,
        minor:    entries.filter((e) => e.item.updateType === 'minor').length,
        breaking: entries.filter((e) => e.item.updateType === 'breaking').length,
    };
}

function buildGroups(
    entries: { item: PackageItem; dev: boolean }[],
    filterType: FilterType,
): GroupItem[] {
    const filtered = filterType === 'all'
        ? entries
        : entries.filter((e) => e.item.updateType === filterType);
    const deps = filtered.filter((e) => !e.dev).map((e) => e.item);
    const devDeps = filtered.filter((e) => e.dev).map((e) => e.item);
    const groups: GroupItem[] = [];
    if (deps.length > 0) {
        groups.push(new GroupItem('Dependencies', deps));
    }
    if (devDeps.length > 0) {
        groups.push(new GroupItem('Dev Dependencies', devDeps));
    }
    return groups;
}
