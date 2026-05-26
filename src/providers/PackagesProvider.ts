import * as vscode from 'vscode';
import { readWorkspaceDependencies, fetchLatestVersion, isVersionOutdated } from '../utils';
import { LoadingItem } from './LoadingItem';
import { PackageItem } from './PackageItem';

export class PackagesProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private items: vscode.TreeItem[] = [];
    private loading = false;

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(): vscode.TreeItem[] {
        if (this.loading) {
            return [new LoadingItem()];
        }
        return this.items;
    }

    async loadPackages(): Promise<void> {
        this.loading = true;
        this._onDidChangeTreeData.fire();
        try {
            const entries = await readWorkspaceDependencies();
            this.items = entries.map((e) => new PackageItem(e.name, e.current, undefined, false));
        } catch {
            this.items = [];
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
            this.items = await Promise.all(
                entries.map(async (entry) => {
                    try {
                        const latest = await fetchLatestVersion(entry.name);
                        const outdated = isVersionOutdated(entry.current, latest);
                        return new PackageItem(entry.name, entry.current, latest, outdated);
                    } catch {
                        return new PackageItem(entry.name, entry.current, undefined, false);
                    }
                }),
            );
        } catch {
            this.items = [];
        } finally {
            this.loading = false;
            this._onDidChangeTreeData.fire();
        }
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}
