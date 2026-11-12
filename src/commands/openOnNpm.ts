import * as vscode from 'vscode';
import { validatePackageName } from '../clients';
import { isPackageItem } from '../providers';
import { COMMAND_IDS } from '../shared';
import { logger, showError } from '../utils';

const NPM_PACKAGE_URL = 'https://www.npmjs.com/package/';

export function openOnNpmCommand(item: unknown): void {
  if (!isPackageItem(item)) {
    logger.warn(`${COMMAND_IDS.openOnNpm} invoked without a valid package item; ignoring.`);
    return;
  }

  try {
    validatePackageName(item.packageName);
  }
  catch (err) {
    showError(vscode.l10n.t('Can\'t open "{0}" on npm: not a valid package name.', item.packageName), err);
    return;
  }

  const { packageName } = item;
  const scoped = packageName.startsWith('@');
  const segments = (scoped ? packageName.slice(1) : packageName).split('/').map(encodeURIComponent);
  const path = `${scoped ? '@' : ''}${segments.join('/')}`;
  void vscode.env.openExternal(vscode.Uri.parse(`${NPM_PACKAGE_URL}${path}`));
}