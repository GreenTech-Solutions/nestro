import * as vscode from 'vscode';
import { expect, vi } from 'vitest';
import { FilterManager, GroupItem, PackageItem, PackagesProvider } from '../../providers';
import type { ReleaseAgeState } from '../../utils';
import { mockNestroConfiguration } from './config';
import { makeProvider } from './providerStub';

const expectedNotification = (message: string): string => `${vscode.l10n.t('Nestro: ')}${message}`;
export const expectErrorNotification = (message: string): void => expect(vscode.window.showErrorMessage)
  .toHaveBeenCalledWith(expectedNotification(message));
export const expectLocalizedErrorNotification = (messageKey: string, ...args: string[]): void =>
  expectErrorNotification(vscode.l10n.t(messageKey, ...args));
export const unverifiedUpdateMessage = (): string => vscode.l10n.t('Package update could not be verified. Refresh the package list and try again.');

const identityMocks = vi.hoisted(() => {
  const makeCapability = (item: {
    packageName: string;
    packageFilePath: string;
    dev: boolean;
    latest?: string;
    installing?: boolean;
    currentVersion?: string;
    releaseAge?: ReleaseAgeState;
  }) => ({
    item: {
      packageName: item.packageName,
      currentVersion: item.currentVersion ?? '',
      latest: item.latest,
      updateType: 'none' as const,
      operation: item.installing
        ? { kind: 'update' as const, target: item.latest ?? item.currentVersion ?? '' }
        : undefined,
      vulnerabilitySeverity: undefined,
      packageFilePath: item.packageFilePath,
      dev: item.dev,
      versionPrefix: item.currentVersion?.match(/^[~^]/)?.[0] ?? '',
      releaseAge: item.releaseAge,
    },
    identity: {
      packageName: item.packageName,
      packageFilePath: item.packageFilePath,
      section: item.dev ? 'devDependencies' as const : 'dependencies' as const,
    },
    packageFilePath: item.packageFilePath,
    packageDirectory: item.packageFilePath.replace(/\/package\.json$/, ''),
    workspaceFolderPath: '/workspace',
    fileStamp: { dev: 1, ino: 1, size: 1, mtimeMs: 1 },
    manifestDigest: 'digest',
    snapshotGeneration: 1,
  });
  return {
    makeCapability,
    resolveCommandPackageItem: vi.fn((item: {
      packageName: string;
      packageFilePath: string;
      dev: boolean;
      latest?: string;
      installing?: boolean;
      currentVersion?: string;
      releaseAge?: ReleaseAgeState;
    }) => item.packageFilePath === '' ? undefined : makeCapability(item)),
    revalidateCommandPackageItem: vi.fn((capability: ReturnType<typeof makeCapability>) => capability),
  };
});

export function getIdentityMocks(): typeof identityMocks {
  return identityMocks;
}

export let taskProcessEndListener: ((event: vscode.TaskProcessEndEvent) => unknown) | undefined;
let taskEndListener: ((event: vscode.TaskEndEvent) => unknown) | undefined;
export let taskExecutionCount = 0;

export function incrementTaskExecutionCount(): void {
  taskExecutionCount += 1;
}

export function mockTaskListeners(): void {
  taskProcessEndListener = undefined;
  taskEndListener = undefined;
  taskExecutionCount = 0;
  vi.mocked(vscode.tasks.onDidEndTaskProcess).mockImplementation((listener) => {
    taskProcessEndListener = listener;
    return { dispose: vi.fn() } as vscode.Disposable;
  });
  vi.mocked(vscode.tasks.onDidEndTask).mockImplementation((listener) => {
    taskEndListener = listener;
    return { dispose: vi.fn() } as vscode.Disposable;
  });
}

export function mockNextTaskExit(exitCode: number | undefined): void {
  vi.mocked(vscode.tasks.executeTask).mockImplementation(() => {
    taskExecutionCount += 1;
    const execution = { id: `task-execution-${taskExecutionCount}` } as unknown as vscode.TaskExecution;
    setTimeout(() => {
      if (exitCode === undefined) {
        taskEndListener?.({ execution } as vscode.TaskEndEvent);
        return;
      }
      taskProcessEndListener?.({ execution, exitCode } as vscode.TaskProcessEndEvent);
    }, 0);
    return Promise.resolve(execution);
  });
}

export function mockDeferredInstall(enabled: boolean): void {
  mockNestroConfiguration({ deferInstallAfterUpdate: enabled });
}

export function makeInstallUpdateProvider(packages: PackageItem[]) {
  return makeProvider({ getVisibleOutdatedPackages: vi.fn(() => packages) });
}

export function makeRealProvider(packages: PackageItem[]): PackagesProvider {
  const provider = new PackagesProvider(new FilterManager('all'));
  Object.assign(provider as unknown as Record<string, unknown>, {
    allEntries: packages.map(item => ({
      item,
      dev: item.dev,
      packageFilePath: item.packageFilePath,
    })),
    loading: false,
  });
  provider.loadPackages = vi.fn();
  provider.refreshPackageBaselineForCapability = vi.fn(capability => Promise.resolve(capability));
  provider.reissuePackageCapability = vi.fn(capability => Promise.resolve(capability));
  provider.markPackageUpdatedForCapability = vi.fn((capability, version) => {
    provider.markPackageUpdated(capability.identity, version);
  });
  provider.markPackageUpdatingForCapability = vi.fn((capability, installing) => {
    provider.markPackageUpdating(capability.identity, installing);
    return capability;
  });
  return provider;
}

export function getRealProviderPackages(provider: PackagesProvider): PackageItem[] {
  return provider.getChildren()
    .filter((item): item is GroupItem => item instanceof GroupItem)
    .flatMap(group => group.children)
    .filter((item): item is PackageItem => item instanceof PackageItem);
}