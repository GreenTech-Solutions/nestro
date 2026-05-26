import * as vscode from 'vscode';
import { readWorkspaceDependencies, fetchLatestVersion, isVersionOutdated } from '../utils';
import { LoadingItem } from './LoadingItem';
import { PackageItem } from './PackageItem';
import { GroupItem } from './GroupItem';

export class PackagesProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private groups: GroupItem[] = [];
    private loading = false;

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
        return this.groups;
    }

    async loadPackages(): Promise<void> {
        this.loading = true;
        this._onDidChangeTreeData.fire();
        try {
            const entries = await readWorkspaceDependencies();
            this.groups = buildGroups(
                entries.map((e) => ({ item: new PackageItem(e.name, e.current, undefined, false), dev: e.dev })),
            );
        } catch {
            this.groups = [];
        } finally {
            this.loading = false;
            this._onDidChangeTreeData.fire();
        }
    }

    async checkUpdates(): Promise<void> {
        this.loading = true;
        this._onDidChangeTreeData.fire();
        try {
            const entries = await readWorkspaceDependencies();
            const results = await Promise.all(
                entries.map(async (entry) => {
                    try {
                        const latest = await fetchLatestVersion(entry.name);
                        const outdated = isVersionOutdated(entry.current, latest);
                        return { item: new PackageItem(entry.name, entry.current, latest, outdated), dev: entry.dev };
                    } catch {
                        return { item: new PackageItem(entry.name, entry.current, undefined, false), dev: entry.dev };
                    }
                }),
            );
            this.groups = buildGroups(results);
        } catch {
            this.groups = [];
        } finally {
            this.loading = false;
            this._onDidChangeTreeData.fire();
        }
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}

function buildGroups(entries: { item: PackageItem; dev: boolean }[]): GroupItem[] {
    const deps = entries.filter((e) => !e.dev).map((e) => e.item);
    const devDeps = entries.filter((e) => e.dev).map((e) => e.item);
    const groups: GroupItem[] = [];
    if (deps.length > 0) {
        groups.push(new GroupItem('Dependencies', deps));
    }
    if (devDeps.length > 0) {
        groups.push(new GroupItem('Dev Dependencies', devDeps));
    }
    return groups;
}
