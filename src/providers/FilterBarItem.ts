import * as vscode from 'vscode';
import { FILTER_TYPES, FilterCounts, FilterType, getFilterIcon, getFilterLabel } from './FilterManager';

export class FilterBarItem extends vscode.TreeItem {
  constructor(
    counts: FilterCounts,
    activeFilter: FilterType,
    search: string,
  ) {
    super(formatLabel(activeFilter, search), vscode.TreeItemCollapsibleState.None);
    this.description = formatFilterLine(counts);
    this.tooltip = search === '' ? 'Select package filter' : `Active package search: ${search}`;
    this.iconPath = getFilterIcon(activeFilter, 'circle-filled');
    this.command = { command: 'nestro.showFilterPicker', title: 'Select Filter' };
    this.contextValue = 'filter';
  }
}

function formatLabel(activeFilter: FilterType, search: string): string {
  return search === ''
    ? `Filter: ${getFilterLabel(activeFilter)}`
    : `Filter: ${getFilterLabel(activeFilter)} · Search: ${search}`;
}

function formatFilterLine(counts: FilterCounts): string {
  return FILTER_TYPES
    .map(filterType => `${getFilterLabel(filterType)} (${counts[filterType]})`)
    .join(' | ');
}
