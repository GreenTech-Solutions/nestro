import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mockNestroConfiguration } from './fixtures/config';
import { buildPackageItem } from './fixtures/packageItem';
import {
  FilterManager,
  PackageItem,
  PackagesProvider,
  StatusItem,
  WorkspaceFolderItem,
} from '../providers';
import type { AuditOrchestrationServiceContract } from '../providers';
import {
  fetchAllLatestVersions,
  readAllWorkspaceDependencies,
  showError,
} from '../utils';
import type { AuditSeverity } from '../utils';
import { packagesProviderMocks } from './fixtures/packagesProviderMocks';
import { getPackageItems, resetPackagesProviderDefaults } from './fixtures/packagesProviderHarness';
const { createClient: createClientMock } = packagesProviderMocks;

interface ContextMenuContribution {
  readonly command: string;
  readonly when: string;
  readonly group?: string;
}

interface ExtensionManifest {
  readonly contributes: {
    readonly menus: {
      readonly 'view/item/context': readonly ContextMenuContribution[];
    };
  };
}

const manifestPath = join(dirname(fileURLToPath(import.meta.url)), '../../package.json');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ExtensionManifest;

const auditSeverities = ['critical', 'high', 'moderate', 'low', 'info'] as const;

function compileViewItemPattern(when: string): RegExp {
  const match = /viewItem\s*=~\s*\/(.*)\/([a-z]*)$/.exec(when);
  if (match === null) {
    throw new Error(`Manifest entry does not contain a viewItem regex: ${when}`);
  }
  return new RegExp(match[1], match[2]);
}

function getMenuPatterns(
  predicate: (entry: ContextMenuContribution) => boolean,
): RegExp[] {
  return manifest.contributes.menus['view/item/context']
    .filter(predicate)
    .map(entry => compileViewItemPattern(entry.when));
}

vi.mock('../clients', async () => (await import('./fixtures/packagesProviderMocks')).createClientsModuleMock());

vi.mock('../utils', async () => (await import('./fixtures/packagesProviderMocks')).createUtilsModuleMock());
describe('PackagesProvider', () => {
  beforeEach(() => {
    resetPackagesProviderDefaults();
  });
  it.each(auditSeverities)('preserves row menu capabilities after a %s audit result', async (severity) => {
    const packageFilePath = '/workspace/package.json';
    const outdatedPackageName = `outdated-${severity}`;
    const packageEntries = [
      {
        name: outdatedPackageName,
        current: '^1.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath,
      },
      {
        name: 'current',
        current: '^1.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath,
      },
      {
        name: 'installing',
        current: '^1.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath,
      },
      {
        name: 'unsupported',
        current: 'npm:real-pkg@^1.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath,
      },
    ];
    const latestVersions = new Map<string, string>([
      [outdatedPackageName, '2.0.0'],
      ['installing', '2.0.0'],
      ['unsupported', '2.0.0'],
    ]);
    const vulnerabilities = new Map<string, AuditSeverity>([
      [outdatedPackageName, severity],
      ['current', 'high'],
      ['installing', 'high'],
      ['unsupported', 'high'],
    ]);
    const updatePatterns = getMenuPatterns(entry => entry.command === 'nestro.installUpdate');
    const pinPatterns = getMenuPatterns(entry => entry.command === 'nestro.pinVersion');
    const managePatterns = getMenuPatterns(entry => entry.group?.startsWith('2_manage') === true);
    const dangerousPatterns = getMenuPatterns(entry => entry.group?.startsWith('3_danger') === true);

    expect(updatePatterns).toHaveLength(1);
    expect(pinPatterns).toHaveLength(1);
    expect(managePatterns).toHaveLength(2);
    expect(dangerousPatterns).toHaveLength(1);
    const updatePattern = updatePatterns[0];
    if (updatePattern === undefined) {
      throw new Error('The Update menu clause is missing.');
    }

    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce(packageEntries);
    vi.mocked(fetchAllLatestVersions).mockResolvedValue(latestVersions);
    createClientMock.mockReturnValue({
      runAudit: vi.fn().mockResolvedValue(vulnerabilities),
    });
    mockNestroConfiguration({ checkUpdatesForceAlways: true, minimumReleaseAgeDays: 0 });

    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    await provider.checkUpdates();
    provider.markPackageUpdating({
      packageName: 'installing',
      packageFilePath,
      section: 'dependencies',
    }, { kind: 'update', target: '2.0.0' });
    await provider.runAudit();

    const rows = new Map(getPackageItems(provider).map(item => [item.packageName, item]));
    const matchesAny = (patterns: readonly RegExp[], contextValue: string | undefined): boolean => (
      patterns.some(pattern => pattern.test(contextValue ?? ''))
    );
    const outdatedRow = rows.get(outdatedPackageName);
    const currentRow = rows.get('current');
    const installingRow = rows.get('installing');
    const unsupportedRow = rows.get('unsupported');

    expect(outdatedRow?.vulnerabilitySeverity).toBe(severity);
    expect(matchesAny([updatePattern], outdatedRow?.contextValue)).toBe(true);
    expect(matchesAny(pinPatterns, outdatedRow?.contextValue)).toBe(true);
    expect(matchesAny(managePatterns, outdatedRow?.contextValue)).toBe(true);
    expect(matchesAny(dangerousPatterns, outdatedRow?.contextValue)).toBe(true);

    expect(currentRow?.vulnerabilitySeverity).toBe('high');
    expect(matchesAny([updatePattern], currentRow?.contextValue)).toBe(false);
    expect(matchesAny(pinPatterns, currentRow?.contextValue)).toBe(true);
    expect(matchesAny(managePatterns, currentRow?.contextValue)).toBe(true);
    expect(matchesAny(dangerousPatterns, currentRow?.contextValue)).toBe(true);

    expect(installingRow?.vulnerabilitySeverity).toBe('high');
    expect(matchesAny([updatePattern], installingRow?.contextValue)).toBe(false);
    expect(matchesAny(pinPatterns, installingRow?.contextValue)).toBe(false);
    expect(matchesAny(managePatterns, installingRow?.contextValue)).toBe(false);
    expect(matchesAny(dangerousPatterns, installingRow?.contextValue)).toBe(false);

    expect(unsupportedRow?.vulnerabilitySeverity).toBe('high');
    expect(matchesAny([updatePattern], unsupportedRow?.contextValue)).toBe(true);
    expect(matchesAny(pinPatterns, unsupportedRow?.contextValue)).toBe(false);
    expect(matchesAny(managePatterns, unsupportedRow?.contextValue)).toBe(true);
    expect(matchesAny(dangerousPatterns, unsupportedRow?.contextValue)).toBe(true);
  });

  it('keeps successful audit results and shows failed package paths', async () => {
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValueOnce([
      {
        name: 'react',
        current: '18.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/apps/web/package.json',
      },
      {
        name: 'react',
        current: '18.0.0',
        dev: false,
        versionPrefix: '',
        packageFilePath: '/workspace/packages/ui/package.json',
      },
    ]);
    createClientMock
      .mockReturnValueOnce({
        runAudit: vi.fn().mockResolvedValue(new Map([['react', 'high']])),
      })
      .mockReturnValueOnce({
        runAudit: vi.fn().mockRejectedValue(new Error('audit unavailable')),
      });

    const provider = new PackagesProvider(new FilterManager('all'));

    await provider.loadPackages();
    await provider.runAudit();

    const folders = provider.getChildren().filter((item): item is WorkspaceFolderItem => item instanceof WorkspaceFolderItem);
    const groups = folders.flatMap(folder => folder.children);
    const packages = groups.flatMap(group => group.children).filter((item): item is PackageItem => item instanceof PackageItem);

    expect(createClientMock).toHaveBeenCalledWith('npm', '/workspace/apps/web');
    expect(createClientMock).toHaveBeenCalledWith('npm', '/workspace/packages/ui');
    expect(showError).not.toHaveBeenCalled();
    expect(packages.map(item => [item.packageFilePath, item.vulnerabilitySeverity])).toEqual([
      ['/workspace/apps/web/package.json', 'high'],
      ['/workspace/packages/ui/package.json', undefined],
    ]);

    const auditStatus = provider.getChildren().find(item => item instanceof StatusItem && item.label === 'Audit incomplete');
    expect(auditStatus).toBeInstanceOf(StatusItem);
    expect(auditStatus?.description).toBe('1 vulnerable package from successful audit roots; 1 package root failed');
    expect(provider.getChildren().some(item => item.label === 'Audit complete')).toBe(false);
    expect(provider.getAuditProjects().map(summary => summary.status)).toEqual(['success', 'failure']);
    expect(provider.getAuditProjects()[1].failure?.reason).toBe('audit-failed');
    expect(provider.getAuditFailures()).toEqual([expect.objectContaining({
      reason: 'audit-failed',
      packageFilePaths: ['/workspace/packages/ui/package.json'],
      project: expect.objectContaining({ projectRoot: '/workspace/packages/ui' }),
    })]);
  });

  it('passes the current package snapshot to the audit service and keeps a discarded result silent', async () => {
    const auditService: AuditOrchestrationServiceContract = {
      run: vi.fn().mockResolvedValue({ kind: 'discarded', reason: 'cancelled' }),
    };
    const provider = new PackagesProvider(new FilterManager('all'), undefined, undefined, auditService);

    await provider.loadPackages();
    await provider.runAudit();

    expect(auditService.run).toHaveBeenCalledWith(expect.objectContaining({
      packageFilePaths: ['/workspace/package.json'],
      rows: expect.arrayContaining([
        expect.objectContaining({
          packageName: 'react',
          packageFilePath: '/workspace/package.json',
          dev: false,
          currentVersion: '18.0.0',
        }),
      ]),
      signal: expect.any(AbortSignal),
      isCurrent: expect.any(Function),
    }));
    expect(provider.getAuditProjects()).toEqual([]);
    expect(provider.getAuditFailures()).toEqual([]);
    expect(provider.getChildren().some(item => item instanceof StatusItem && (
      item.label === 'Audit complete' || item.label === 'Audit incomplete'
    ))).toBe(false);
  });

  it('applies a service failure without pretending the audit completed', async () => {
    const auditService: AuditOrchestrationServiceContract = {
      run: vi.fn().mockResolvedValue({
        kind: 'failed',
        reason: 'unresolvable-path',
        detail: 'Manifest disappeared.',
      }),
    };
    const provider = new PackagesProvider(new FilterManager('all'), undefined, undefined, auditService);

    await provider.loadPackages();
    await provider.runAudit();

    expect(provider.getAuditFailures()).toEqual([{
      packageFilePaths: [],
      reason: 'unresolvable-path',
      detail: 'Manifest disappeared.',
    }]);
    const auditStatus = provider.getChildren().find(item => (
      item instanceof StatusItem && item.label === 'Audit failed'
    ));
    expect(auditStatus).toBeInstanceOf(StatusItem);
    expect(auditStatus?.description).toBe('No audit results available');
    expect(auditStatus?.command?.command).toBe('nestro.openStatusReport');
    expect(showError).toHaveBeenCalledWith('Package audit failed — the security audit report is incomplete.');
  });

  it('shows the running audit state and contains package detail paths defensively', async () => {
    let releaseAudit: (value: Map<string, AuditSeverity>) => void = () => {};
    createClientMock.mockReturnValue({
      runAudit: vi.fn().mockReturnValue(new Promise<Map<string, AuditSeverity>>((resolve) => {
        releaseAudit = resolve;
      })),
    });
    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    const audit = provider.runAudit();

    expect(provider.getChildren().some(item => item instanceof StatusItem && item.label === 'Running audit…')).toBe(true);
    releaseAudit(new Map());
    await audit;

    const emptyPathItem = buildPackageItem({ name: 'empty', currentVersion: '1.0.0', packageFilePath: '' });
    const outsidePathItem = buildPackageItem({ name: 'outside', currentVersion: '1.0.0', packageFilePath: '/outside/package.json' });
    expect(provider.getChildren(emptyPathItem)).toHaveLength(2);
    expect(provider.getChildren(outsidePathItem)).toEqual([
      expect.objectContaining({ label: 'Dependency' }),
      expect.objectContaining({ label: 'Current: 1.0.0' }),
      expect.objectContaining({ label: 'File: /outside/package.json' }),
    ]);
  });

  it('keeps search clearing and invalid capability input side-effect free', async () => {
    const provider = new PackagesProvider(new FilterManager('all'));

    provider.clearSearch();

    await expect(provider.resolvePackageItem(undefined)).resolves.toEqual({
      ok: false,
      reason: 'invalid-item',
    });
    expect(provider.getVisibleOutdatedPackages()).toEqual([]);
  });
});