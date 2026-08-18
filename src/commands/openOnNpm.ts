import * as vscode from 'vscode';
import { isPackageItem } from '../providers';
import { logger } from '../utils';

export function openOnNpmCommand(item: unknown): void {
  if (!isPackageItem(item)) {
    logger.warn('nestro.openOnNpm invoked without a valid package item; ignoring.');
    return;
  }

  void vscode.env.openExternal(vscode.Uri.parse(`https://www.npmjs.com/package/${item.packageName}`));
}