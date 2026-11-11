import * as vscode from 'vscode';

export { validatePackageName } from '../utils/packageNameValidation';

const CONTROL_CHARACTER_PATTERN = /[\x00-\x1f\x7f]/;

/**
 * Rejects only a leading hyphen or control characters: no semver, prerelease,
 * dist-tag, or `workspace:` spec ever starts with either.
 */
export function validatePackageVersionSpec(version: string): void {
  if (version.length === 0) {
    throw new Error(vscode.l10n.t('Package version cannot be empty.'));
  }
  if (version.startsWith('-')) {
    throw new Error(vscode.l10n.t('Package version "{0}" cannot start with a hyphen.', version));
  }
  if (CONTROL_CHARACTER_PATTERN.test(version)) {
    throw new Error(vscode.l10n.t('Package version "{0}" contains control characters.', version));
  }
}