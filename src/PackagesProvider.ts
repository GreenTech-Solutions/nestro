import * as vscode from 'vscode';
import { readWorkspaceDependencies, fetchLatestVersion } from './packageUtils';

class LoadingItem extends vscode.TreeItem {
    constructor() {
        super('Loading packages…', vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('loading~spin');
    }
}

export class PackageItem extends vscode.TreeItem {
    constructor(
        public readonly packageName: string,
        public readonly currentVersion: string,
        public readonly latest: string | undefined,
        outdated: boolean,
    ) {
        super(packageName, vscode.TreeItemCollapsibleState.None);
        this.description = latest ? `${currentVersion} → ${latest}` : currentVersion;
        this.tooltip = `${packageName}@${currentVersion}${latest ? ` (latest: ${latest})` : ''}`;
        this.contextValue = outdated ? 'outdated' : 'package';
        this.iconPath = outdated
            ? new vscode.ThemeIcon('arrow-up', new vscode.ThemeColor('charts.yellow'))
            : new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
    }
}

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

    async refresh(): Promise<void> {
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

function isVersionOutdated(current: string, latest: string): boolean {
    const clean = current.replace(/^[^0-9]*/, '').trim();
    return clean !== latest;
}
