import * as vscode from 'vscode';

export { validatePackageName } from '../utils/packageNameValidation';

const CONTROL_CHARACTER_PATTERN = /[\x00-\x1f\x7f]/;

const NUMERIC_IDENTIFIER = '(?:0|[1-9]\\d*)';
const PRERELEASE_IDENTIFIER = `(?:${NUMERIC_IDENTIFIER}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`;
const CONCRETE_SEMVER = `${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}`
  + `(?:-${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*)?`
  + '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?';
const SEMVER_RANGE = `[~^]?${CONCRETE_SEMVER}`;
const DIST_TAG = '[A-Za-z][A-Za-z0-9._-]*';
const WORKSPACE_FORM = `workspace:(?:[*~^]|${SEMVER_RANGE})`;
const VERSION_SPEC_PATTERN = new RegExp(`^(?:${SEMVER_RANGE}|${DIST_TAG}|${WORKSPACE_FORM})$`);

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
  if (!VERSION_SPEC_PATTERN.test(version)) {
    throw new Error(vscode.l10n.t(
      'Package version "{0}" is not a version, version range, dist-tag, or workspace spec.',
      version,
    ));
  }
}