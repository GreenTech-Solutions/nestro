import * as vscode from 'vscode';
import { parseDependencySpec } from '../utils';
import type { AuditSeverity, ReleaseAgeState, UpdateType } from '../utils';
import { configurePackageItemPresentation, resolveWorkspaceOwner, sanitizePackageText } from './packageItemPresentation';

export type PackageOperation
  = | { readonly kind: 'update'; readonly target: string }
    | { readonly kind: 'remove' }
    | { readonly kind: 'install' }
    | { readonly kind: 'pin' }
    | { readonly kind: 'switch' };

export type PackageOperationInput = PackageOperation | boolean | undefined;

export class PackageItem extends vscode.TreeItem {
  public readonly operation: PackageOperation | undefined;
  public readonly workspaceOwner: string | undefined;

  constructor(
    public readonly packageName: string,
    public readonly currentVersion: string,
    public readonly latest: string | undefined,
    public readonly updateType: UpdateType,
    operation: PackageOperationInput = undefined,
    public readonly vulnerabilitySeverity: AuditSeverity | undefined = undefined,
    public readonly packageFilePath = '',
    public readonly dev = false,
    public readonly versionPrefix = '',
    public readonly releaseAge: ReleaseAgeState = { kind: 'accepted' },
    workspaceOwner?: string,
  ) {
    const safePackageName = sanitizePackageText(packageName);
    const safeCurrentVersion = sanitizePackageText(currentVersion);
    const safeLatest = latest === undefined ? undefined : sanitizePackageText(latest);
    const resolvedWorkspaceOwner = workspaceOwner ?? resolveWorkspaceOwner(packageFilePath);
    super(safePackageName, vscode.TreeItemCollapsibleState.Collapsed);
    this.workspaceOwner = resolvedWorkspaceOwner === undefined
      ? undefined
      : sanitizePackageText(resolvedWorkspaceOwner);
    this.operation = normalizeOperation(operation, latest ?? currentVersion);
    const parsedSpec = parseDependencySpec(currentVersion);
    configurePackageItemPresentation(this, {
      packageName: safePackageName,
      currentVersion: safeCurrentVersion,
      latest: safeLatest,
      updateType,
      vulnerabilitySeverity,
      operation: this.operation,
      workspaceOwner: this.workspaceOwner,
      parsedSpec,
      releaseAge,
    });
  }

  get installing(): boolean {
    return this.operation !== undefined;
  }
}

export function normalizeOperation(operation: PackageOperationInput, defaultTarget: string): PackageOperation | undefined {
  if (typeof operation !== 'boolean') {
    return operation;
  }
  return operation ? { kind: 'update', target: defaultTarget } : undefined;
}

/**
 * Narrows an unknown command argument to `PackageItem`: the Command Palette can invoke a
 * command with no argument, and `executeCommand()` accepts any value regardless of the
 * declared parameter type, so callers must not assume the argument is well-formed.
 */
export function isPackageItem(value: unknown): value is PackageItem {
  try {
    return value instanceof PackageItem;
  }
  catch {
    return false;
  }
}