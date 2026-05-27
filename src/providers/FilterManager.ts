import * as vscode from 'vscode';

export const FILTER_TYPES = ['all', 'hasUpdates', 'patch', 'minor', 'breaking'] as const;

export type FilterType = typeof FILTER_TYPES[number];

export interface FilterCounts extends Record<FilterType, number> {}

const FILTER_CONFIG: Record<FilterType, { label: string; color?: string }> = {
  all: { label: 'All' },
  hasUpdates: { label: 'Has Updates', color: 'charts.blue' },
  patch: { label: 'Minor', color: 'charts.green' },
  minor: { label: 'Major', color: 'charts.yellow' },
  breaking: { label: 'Breaking', color: 'charts.red' },
};

export function isFilterType(value: unknown): value is FilterType {
  return typeof value === 'string' && (FILTER_TYPES as readonly string[]).includes(value);
}

export function getFilterLabel(filterType: FilterType): string {
  return FILTER_CONFIG[filterType].label;
}

export function getFilterIcon(
  filterType: FilterType,
  icon: string,
): vscode.ThemeIcon {
  const cfg = FILTER_CONFIG[filterType];
  return cfg.color
    ? new vscode.ThemeIcon(icon, new vscode.ThemeColor(cfg.color))
    : new vscode.ThemeIcon(icon);
}

export function createFilterQuickPickItems(
  counts: FilterCounts,
  activeFilter: FilterType,
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

  private _current: FilterType;

  constructor(initialFilter: FilterType = 'all') {
    this._current = initialFilter;
  }

  get current(): FilterType {
    return this._current;
  }

  set(type: FilterType): void {
    if (this._current === type) {
      return;
    }
    this._current = type;
    this._onDidChange.fire();
  }

  async showPicker(counts: FilterCounts): Promise<void> {
    const selected = await vscode.window.showQuickPick(
      createFilterQuickPickItems(counts, this._current),
      { placeHolder: 'Select package filter' },
    );
    if (selected) {
      this.set(selected.filterType);
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}