import * as vscode from 'vscode';
import { classifyPackageName, isVersionOperand } from '../shared';

const CONTROL_CHARACTER_PATTERN = /[\x00-\x1f\x7f]/;

/** Throws a localized error when the name is empty, option-like, malformed or not URL-safe. */
export function validatePackageName(name: string): void {
  const problem = classifyPackageName(name);
  switch (problem?.kind) {
    case undefined:
      return;
    case 'empty':
      throw new Error(vscode.l10n.t('Package name cannot be empty.'));
    case 'leading-hyphen':
      throw new Error(vscode.l10n.t('Package name "{0}" cannot start with a hyphen.', name));
    case 'malformed':
      throw new Error(vscode.l10n.t('Package name "{0}" is not a valid package or scoped package name.', name));
    case 'unsafe-scope':
      throw new Error(vscode.l10n.t('Package scope "{0}" contains characters a registry URL can\'t carry.', problem.segment));
    case 'unsafe-name':
      throw new Error(vscode.l10n.t('Package name "{0}" contains characters a registry URL can\'t carry.', problem.segment));
  }
}

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