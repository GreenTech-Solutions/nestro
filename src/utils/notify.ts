import * as vscode from 'vscode';
import { logger, sanitizeLogText } from './logger';

const MAX_NOTIFICATION_LENGTH = 240;
const ABSOLUTE_PATH_PATTERN = /(^|[\s("'`])((?:\/(?!\/)|[A-Za-z]:[\\/])[^\s"'`<>(){}[\],;:!?]*)(?=$|[\s"'`<>(){}[\],;:!?])/g;

export function showError(message: string, err?: unknown): void {
  logger.error(message, err);
  const notification = relativizeWorkspacePaths(sanitizeLogText(message));
  const prefix = 'Nestro: ';
  const availableLength = MAX_NOTIFICATION_LENGTH - prefix.length;
  const boundedNotification = notification.length <= availableLength
    ? notification
    : `${notification.slice(0, availableLength - 1)}…`;

  void vscode.window.showErrorMessage(`${prefix}${boundedNotification}`);
}

function relativizeWorkspacePaths(message: string): string {
  return message.replace(ABSOLUTE_PATH_PATTERN, (match, prefix: string, absolutePath: string) => {
    const relativePath = vscode.workspace.asRelativePath(absolutePath);
    return relativePath === absolutePath ? match : `${prefix}${relativePath}`;
  });
}