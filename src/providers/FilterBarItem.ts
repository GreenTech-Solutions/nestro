import * as vscode from 'vscode';

export const FILTER_TYPES = ['all', 'hasUpdates', 'patch', 'minor', 'breaking'] as const;

export type FilterType = typeof FILTER_TYPES[number];

const FILTER_CONFIG: Record<FilterType, { label: string; color?: string }> = {
  all: { label: 'All' },
  hasUpdates: { label: 'Has Updates', color: 'charts.blue' },
  patch: { label: 'Minor', color: 'charts.green' },
  minor: { label: 'Major', color: 'charts.yellow' },
  breaking: { label: 'Breaking', color: 'charts.red' },
};

export type FilterCounts = Record<FilterType, number>;

export function isFilterType(value: unknown): value is FilterType {
  return typeof value === 'string' && (FILTER_TYPES as readonly string[]).includes(value);
}

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
  return FILTER_TYPES.map((filterType) => {
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
  return FILTER_TYPES
    .map(filterType => `${FILTER_CONFIG[filterType].label} (${counts[filterType]})`)
    .join(' | ');
}