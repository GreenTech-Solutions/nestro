import * as vscode from 'vscode';
import { isVersionOperand } from '../shared';

export { validatePackageName } from '../utils/packageNameValidation';

const CONTROL_CHARACTER_PATTERN = /[\x00-\x1f\x7f]/;

/**
 * Accepts a concrete semver with an optional `^`/`~`, a dist-tag, or a `workspace:` form;
 * everything else, including every shell metacharacter, is rejected before a task is built.
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
  if (!isVersionOperand(version)) {
    throw new Error(vscode.l10n.t(
      'Package version "{0}" is not a version, version range, dist-tag, or workspace spec.',
      version,
    ));
  }
}