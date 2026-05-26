import * as vscode from 'vscode';

export type FilterType = 'all' | 'hasUpdates' | 'patch' | 'minor' | 'breaking';

const FILTER_CONFIG: Record<FilterType, { label: string; color?: string }> = {
  all: { label: 'All' },
  hasUpdates: { label: 'Has Updates', color: 'charts.blue' },
  patch: { label: 'Minor', color: 'charts.green' },
  minor: { label: 'Major', color: 'charts.yellow' },
  breaking: { label: 'Breaking', color: 'charts.red' },
};

export type FilterCounts = Record<FilterType, number>;

export class FilterBarItem extends vscode.TreeItem {
  constructor(
    counts: FilterCounts,
    activeFilter: FilterType,
  ) {
    const activeConfig = FILTER_CONFIG[activeFilter];
    super(`Filter: ${activeConfig.label}`, vscode.TreeItemCollapsibleState.None);
    this.description = formatFilterLine(counts);
    this.tooltip = 'Select package filter';
    const cfg = FILTER_CONFIG[activeFilter];
    this.iconPath = cfg.color
      ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(cfg.color))
      : new vscode.ThemeIcon('circle-filled');
    this.command = { command: 'nestro.showFilterPicker', title: 'Select Filter' };
    this.contextValue = 'filter';
  }
}

export function createFilterQuickPickItems(
  counts: FilterCounts,
  activeFilter: FilterType,
): (vscode.QuickPickItem & { filterType: FilterType })[] {
  const filters: FilterType[] = ['all', 'hasUpdates', 'patch', 'minor', 'breaking'];
  return filters.map((filterType) => {
    const cfg = FILTER_CONFIG[filterType];
    const icon = activeFilter === filterType ? 'circle-filled' : 'circle-large-outline';
    return {
      label: cfg.label,
      description: String(counts[filterType]),
      iconPath: cfg.color
        ? new vscode.ThemeIcon(icon, new vscode.ThemeColor(cfg.color))
        : new vscode.ThemeIcon(icon),
      filterType,
    };
  });
}

function formatFilterLine(counts: FilterCounts): string {
  const filters: FilterType[] = ['all', 'hasUpdates', 'patch', 'minor', 'breaking'];
  return filters
    .map(filterType => `${FILTER_CONFIG[filterType].label} (${counts[filterType]})`)
    .join(' | ');
}