import * as vscode from 'vscode';
import { FILTER_TYPES, FilterCounts, FilterType, getFilterIcon, getFilterLabel } from './FilterManager';

export class FilterBarItem extends vscode.TreeItem {
  constructor(
    counts: FilterCounts,
    activeFilter: FilterType,
  ) {
    super(`Filter: ${getFilterLabel(activeFilter)}`, vscode.TreeItemCollapsibleState.None);
    this.description = formatFilterLine(counts);
    this.tooltip = 'Select package filter';
    this.iconPath = getFilterIcon(activeFilter, 'circle-filled');
    this.command = { command: 'nestro.showFilterPicker', title: 'Select Filter' };
    this.contextValue = 'filter';
  }
}

function formatFilterLine(counts: FilterCounts): string {
  return FILTER_TYPES
    .map(filterType => `${getFilterLabel(filterType)} (${counts[filterType]})`)
    .join(' | ');
}