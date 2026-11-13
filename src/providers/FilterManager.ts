import * as vscode from 'vscode';
import { FILTER_TYPES, isFilterType, PACKAGE_PRESENTATION } from '../shared';
import type { FilterType } from '../shared';

export { FILTER_TYPES, isFilterType };
export type { FilterType };

export type PackageFilter = FilterType | 'vulnerable';

export interface FilterCounts extends Record<PackageFilter, number> {}

const FILTER_LABELS: Record<PackageFilter, string> = {
  all: vscode.l10n.t('All'),
  hasUpdates: vscode.l10n.t('Has Updates'),
  patch: vscode.l10n.t('Patch'),
  minor: vscode.l10n.t('Minor'),
  breaking: vscode.l10n.t('Breaking'),
  vulnerable: vscode.l10n.t('Vulnerable'),
};

export function getFilterLabel(filterType: PackageFilter): string {
  return FILTER_LABELS[filterType];
}

export function getFilterIcon(
  filterType: PackageFilter,
  icon: string,
): vscode.ThemeIcon {
  const color = PACKAGE_PRESENTATION.filterColors[filterType];
  return color !== undefined
    ? new vscode.ThemeIcon(icon, new vscode.ThemeColor(color))
    : new vscode.ThemeIcon(icon);
}

export function createFilterQuickPickItems(
  counts: FilterCounts,
  activeFilter: PackageFilter,
): (vscode.QuickPickItem & { filterType: FilterType })[] {
  return FILTER_TYPES.map((filterType) => {
    const icon = activeFilter === filterType ? 'circle-filled' : 'circle-large-outline';
    return {
      label: getFilterLabel(filterType),
      description: String(counts[filterType]),
      iconPath: getFilterIcon(filterType, icon),
      filterType,
    };
  });
}

export class FilterManager implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private _current: PackageFilter;
  private _search = '';
  private readonly clearSearchButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('clear-all'),
    tooltip: vscode.l10n.t('Clear search query'),
  };

  constructor(initialFilter: FilterType = 'all') {
    this._current = initialFilter;
  }

  get current(): PackageFilter {
    return this._current;
  }

  get search(): string {
    return this._search;
  }

  set(type: FilterType): void {
    if (this._current === type) {
      return;
    }
    this._current = type;
    this._onDidChange.fire();
  }

  showVulnerable(): void {
    if (this._current === 'vulnerable') {
      return;
    }
    this._current = 'vulnerable';
    this._onDidChange.fire();
  }

  setSearch(value: string): void {
    const normalized = value.trim().toLocaleLowerCase();
    if (this._search === normalized) {
      return;
    }
    this._search = normalized;
    this._onDidChange.fire();
  }

  clearSearch(): void {
    this.setSearch('');
  }

  async showSearch(): Promise<void> {
    const inputBox = vscode.window.createInputBox();
    inputBox.title = vscode.l10n.t('Search packages');
    inputBox.prompt = vscode.l10n.t('Search packages by name');
    inputBox.placeholder = vscode.l10n.t('Type a package name');
    inputBox.value = this._search;
    inputBox.buttons = [this.clearSearchButton];

    const result = await new Promise<string | undefined>((resolve) => {
      const disposables: vscode.Disposable[] = [];
      let finished = false;
      const finish = (value: string | undefined): void => {
        if (finished) {
          return;
        }
        finished = true;
        while (disposables.length > 0) {
          disposables.pop()?.dispose();
        }
        inputBox.dispose();
        resolve(value);
      };

      disposables.push(
        inputBox.onDidAccept(() => {
          finish(inputBox.value);
          inputBox.hide();
        }),
        inputBox.onDidHide(() => {
          finish(undefined);
        }),
        inputBox.onDidTriggerButton((button) => {
          if (button === this.clearSearchButton) {
            inputBox.value = '';
          }
        }),
      );

      inputBox.show();
    });

    if (result !== undefined) {
      this.setSearch(result);
    }
  }

  async showPicker(counts: FilterCounts): Promise<void> {
    const selected = await vscode.window.showQuickPick(
      createFilterQuickPickItems(counts, this._current),
      { placeHolder: vscode.l10n.t('Select package filter') },
    );
    if (selected) {
      this.set(selected.filterType);
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}