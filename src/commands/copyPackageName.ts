import * as vscode from 'vscode';
import { isPackageItem } from '../providers';
import { COMMAND_IDS } from '../shared';
import { logger } from '../utils';

export function copyPackageNameCommand(item: unknown): void {
  if (!isPackageItem(item)) {
    logger.warn(`${COMMAND_IDS.copyPackageName} invoked without a valid package item; ignoring.`);
    return;
  }

  void vscode.env.clipboard.writeText(item.packageName);
}