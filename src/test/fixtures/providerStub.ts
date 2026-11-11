import { vi } from 'vitest';
import { FilterManager, PackagesProvider } from '../../providers';
import type {
  PackageLoadingServiceContract,
} from '../../providers';

function createProviderMethods() {
  const markPackageUpdated = vi.fn<PackagesProvider['markPackageUpdated']>();
  const markPackageUpdating = vi.fn<PackagesProvider['markPackageUpdating']>();
  return {
    attachTreeView: vi.fn<PackagesProvider['attachTreeView']>(),
    cancelAudit: vi.fn<PackagesProvider['cancelAudit']>(),
    cancelCheckUpdates: vi.fn<PackagesProvider['cancelCheckUpdates']>(),
    checkUpdates: vi.fn<PackagesProvider['checkUpdates']>(() => Promise.resolve()),
    clearSearch: vi.fn<PackagesProvider['clearSearch']>(),
    dispose: vi.fn<PackagesProvider['dispose']>(),
    getAuditFailures: vi.fn<PackagesProvider['getAuditFailures']>(() => []),
    getAuditProjects: vi.fn<PackagesProvider['getAuditProjects']>(() => []),
    getAuditReport: vi.fn<PackagesProvider['getAuditReport']>(),
    getChildren: vi.fn<PackagesProvider['getChildren']>(() => []),
    onDidChangeTreeData: vi.fn<PackagesProvider['onDidChangeTreeData']>(() => ({ dispose: vi.fn() })),
    getPackageIdentitiesForFile: vi.fn<PackagesProvider['getPackageIdentitiesForFile']>(() => []),
    getStatusReport: vi.fn<PackagesProvider['getStatusReport']>(),
    getTreeItem: vi.fn<PackagesProvider['getTreeItem']>(item => item),
    getVisibleOutdatedPackages: vi.fn<PackagesProvider['getVisibleOutdatedPackages']>(() => []),
    invalidateUpdateCache: vi.fn<PackagesProvider['invalidateUpdateCache']>(),
    isOwnManifestWrite: vi.fn<PackagesProvider['isOwnManifestWrite']>(() => Promise.resolve(false)),
    loadPackages: vi.fn<PackagesProvider['loadPackages']>(() => Promise.resolve()),
    markPackageUpdated,
    markPackageUpdatedForCapability: vi.fn<PackagesProvider['markPackageUpdatedForCapability']>((capability, version) => {
      markPackageUpdated(capability.identity, version);
    }),
    markPackageUpdating,
    markPackageUpdatingForCapability: vi.fn<PackagesProvider['markPackageUpdatingForCapability']>((capability, operation) => {
      markPackageUpdating(capability.identity, operation);
      return capability;
    }),
    refreshPackageBaselineForCapability: vi.fn<PackagesProvider['refreshPackageBaselineForCapability']>(capability => Promise.resolve(capability)),
    reissuePackageCapability: vi.fn<PackagesProvider['reissuePackageCapability']>(capability => Promise.resolve(capability)),
    revalidatePackageItem: vi.fn<PackagesProvider['revalidatePackageItem']>(() => Promise.resolve({ ok: false, reason: 'invalid-item' })),
    resetUpdateData: vi.fn<PackagesProvider['resetUpdateData']>(),
    resolvePackageItem: vi.fn<PackagesProvider['resolvePackageItem']>(() => Promise.resolve({ ok: false, reason: 'invalid-item' })),
    runAudit: vi.fn<PackagesProvider['runAudit']>(() => Promise.resolve()),
    setFilter: vi.fn<PackagesProvider['setFilter']>(),
    showFilterPicker: vi.fn<PackagesProvider['showFilterPicker']>(() => Promise.resolve()),
    showSearch: vi.fn<PackagesProvider['showSearch']>(() => Promise.resolve()),
    withWriteSuppressed: vi.fn<PackagesProvider['withWriteSuppressed']>(async <T>(operation: () => Promise<T>) => await operation()),
  };
}

type ProviderMethods = ReturnType<typeof createProviderMethods>;

export type ProviderStub = PackagesProvider & ProviderMethods;

export function makeProvider(overrides: Partial<ProviderMethods> = {}): ProviderStub {
  const provider = { ...createProviderMethods(), ...overrides } as unknown as ProviderStub;
  if (overrides.markPackageUpdatedForCapability === undefined) {
    provider.markPackageUpdatedForCapability.mockImplementation((capability, version) => {
      provider.markPackageUpdated(capability.identity, version);
    });
  }
  if (overrides.markPackageUpdatingForCapability === undefined) {
    provider.markPackageUpdatingForCapability.mockImplementation((capability, operation) => {
      provider.markPackageUpdating(capability.identity, operation);
      return capability;
    });
  }
  return provider;
}

export interface ProviderFactoryOptions {
  readonly packageLoadingService: PackageLoadingServiceContract;
  readonly updateOrchestrationService?: NonNullable<ConstructorParameters<typeof PackagesProvider>[2]>;
  readonly auditOrchestrationService?: NonNullable<ConstructorParameters<typeof PackagesProvider>[3]>;
  readonly filterManager?: FilterManager;
}

export function createProvider(options: ProviderFactoryOptions): PackagesProvider {
  return new PackagesProvider(
    options.filterManager ?? new FilterManager('all'),
    options.packageLoadingService,
    options.updateOrchestrationService,
    options.auditOrchestrationService,
  );
}