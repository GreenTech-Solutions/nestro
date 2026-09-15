import * as vscode from 'vscode';
import { FILTER_TYPES, FilterCounts, FilterType, getFilterIcon, getFilterLabel } from './FilterManager';

export class FilterBarItem extends vscode.TreeItem {
  constructor(
    counts: FilterCounts,
    activeFilter: FilterType,
  ) {
    super(vscode.l10n.t('Filter: {0}', getFilterLabel(activeFilter)), vscode.TreeItemCollapsibleState.None);
    this.description = formatFilterLine(counts);
    this.tooltip = vscode.l10n.t('Select package filter');
    this.iconPath = getFilterIcon(activeFilter, 'circle-filled');
    this.command = { command: 'nestro.showFilterPicker', title: vscode.l10n.t('Select Filter') };
    this.contextValue = 'filter';
  }
}

function formatFilterLine(counts: FilterCounts): string {
  const segments = FILTER_TYPES.map(filterType => vscode.l10n.t(
    '{0} ({1})',
    getFilterLabel(filterType),
    counts[filterType],
  ));
  return segments.reduce(
    (line, segment) => line === '' ? segment : vscode.l10n.t('{0} | {1}', line, segment),
    '',
  );
}