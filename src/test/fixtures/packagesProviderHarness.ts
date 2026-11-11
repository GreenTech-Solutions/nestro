import * as vscode from 'vscode';
import { GroupItem } from '../../providers/GroupItem';
import { PackageItem } from '../../providers/PackageItem';
import type { PackagesProvider } from '../../providers';
import { vi } from 'vitest';
import { fetchAllLatestVersions, fetchPackageMetadata, getWorkspacePackageFilePaths, readAllWorkspaceDependencies, resolveYarnFamily } from '../../utils';
import { getUpdateType as realGetUpdateType } from '../../utils/versionUtils';
import { mockNestroConfiguration } from './config';
import { packagesProviderMocks } from './packagesProviderMocks';

export function getLastContextValue(context: string): unknown {
  const calls = vi.mocked(vscode.commands.executeCommand).mock.calls as unknown as readonly unknown[][];
  const contextCalls = calls.filter(call => call[0] === 'setContext' && call[1] === context);
  return contextCalls.at(-1)?.[2];
}

export function getPackageItems(provider: PackagesProvider): PackageItem[] {
  return provider.getChildren()
    .filter((item): item is GroupItem => item instanceof GroupItem)
    .flatMap(group => group.children)
    .filter((item): item is PackageItem => item instanceof PackageItem);
}

export function setProviderState(
  provider: PackagesProvider,
  state: {
    allEntries?: unknown[];
    auditState?: string;
    auditResults?: Map<string, unknown>;
    checkState?: string;
    lastAuditCount?: number;
    lastCheckTime?: Date;
    loading?: boolean;
  },
): void {
  Object.assign((provider as unknown as { state: Record<string, unknown> }).state, state);
}

export function resetPackagesProviderDefaults(): void {
  vi.clearAllMocks();
  mockNestroConfiguration({});
  packagesProviderMocks.getUpdateType.mockImplementation(realGetUpdateType);
  vi.mocked(readAllWorkspaceDependencies).mockResolvedValue([
    {
      name: 'react',
      current: '18.0.0',
      dev: false,
      versionPrefix: '',
      packageFilePath: '/workspace/package.json',
    },
    {
      name: 'eslint',
      current: '8.0.0',
      dev: true,
      versionPrefix: '',
      packageFilePath: '/workspace/package.json',
    },
  ]);
  vi.mocked(fetchAllLatestVersions).mockResolvedValue(new Map([
    ['react', '19.0.0'],
  ]));
  vi.mocked(fetchPackageMetadata).mockResolvedValue({
    kind: 'success',
    result: {
      versions: [],
      distTags: {},
      publishTimes: { kind: 'not-provided' },
    },
  });
  vi.mocked(getWorkspacePackageFilePaths).mockResolvedValue(['/workspace/package.json']);
  vi.mocked(resolveYarnFamily).mockResolvedValue({ family: 'classic', source: 'project-markers' });
  packagesProviderMocks.createClient.mockReset();
  packagesProviderMocks.resolveAuditProjects.mockReset();
  // Default: every package file is its own independent project (no shared
  // ancestor lockfile), matching the real resolver when no manager signal is
  // shared between manifests. Tests that need a merged multi-manifest project
  // override this per test.
  packagesProviderMocks.resolveAuditProjects.mockImplementation((packageFilePaths: readonly string[]) => ({
    projects: packageFilePaths.map(packageFilePath => ({
      projectRoot: packageFilePath.replace(/\/package\.json$/, ''),
      workspaceFolder: '/workspace',
      packageManager: 'npm' as const,
      lockfilePath: undefined,
      originManifests: [packageFilePath],
    })),
    rejected: [],
  }));
}