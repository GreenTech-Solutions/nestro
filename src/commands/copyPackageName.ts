import * as vscode from 'vscode';
import { isPackageItem } from '../providers';
import { logger } from '../utils';

export function copyPackageNameCommand(item: unknown): void {
  if (!isPackageItem(item)) {
    logger.warn('nestro.copyPackageName invoked without a valid package item; ignoring.');
    return;
  }

  void vscode.env.clipboard.writeText(item.packageName);
}