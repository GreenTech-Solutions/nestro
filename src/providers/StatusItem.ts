import * as vscode from 'vscode';

export const OPEN_STATUS_REPORT_COMMAND = 'nestro.openStatusReport';

/** An explicit command a status row opens on click, in place of the diagnostics report. */
export interface StatusItemCommand {
  readonly command: string;
  readonly title: string;
}

export class StatusItem extends vscode.TreeItem {
  constructor(
    label: string,
    description: string,
    icon: string,
    color?: string,
    actionable = false,
    command?: StatusItemCommand,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = 'status';
    this.iconPath = color === undefined
      ? new vscode.ThemeIcon(icon)
      : new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    if (command !== undefined) {
      this.command = { command: command.command, title: command.title };
      this.tooltip = description === ''
        ? vscode.l10n.t('{0}. {1}', label, command.title)
        : vscode.l10n.t('{0}. {1}. {2}', label, description, command.title);
      this.accessibilityInformation = { label: this.tooltip };
    }
    else if (actionable) {
      const action = vscode.l10n.t('Open detailed diagnostics');
      this.command = {
        command: OPEN_STATUS_REPORT_COMMAND,
        title: action,
      };
      this.tooltip = vscode.l10n.t('{0}: {1}', label, action);
      this.accessibilityInformation = {
        label: description === ''
          ? vscode.l10n.t('{0}. {1}', label, action)
          : vscode.l10n.t('{0}. {1}. {2}', label, description, action),
      };
    }
  }
}