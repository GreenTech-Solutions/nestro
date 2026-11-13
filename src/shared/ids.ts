/** Command ids declared in `contributes.commands`. */
export const COMMAND_IDS = {
  refresh: 'nestro.refresh',
  checkUpdates: 'nestro.checkUpdates',
  runAudit: 'nestro.runAudit',
  openAuditReport: 'nestro.openAuditReport',
  openStatusReport: 'nestro.openStatusReport',
  installUpdate: 'nestro.installUpdate',
  pickVersion: 'nestro.pickVersion',
  switchDepType: 'nestro.switchDepType',
  pinVersion: 'nestro.pinVersion',
  removePackage: 'nestro.removePackage',
  updateAllVisible: 'nestro.updateAllVisible',
  runInstall: 'nestro.runInstall',
  openOnNpm: 'nestro.openOnNpm',
  copyPackageName: 'nestro.copyPackageName',
  setFilter: 'nestro.setFilter',
  showFilterPicker: 'nestro.showFilterPicker',
  showVulnerablePackages: 'nestro.showVulnerablePackages',
  searchPackages: 'nestro.searchPackages',
  clearSearchQuery: 'nestro.clearSearchQuery',
  openSettings: 'nestro.openSettings',
  pinAllVersions: 'nestro.pinAllVersions',
} as const;

/** View and view-container ids declared in `contributes.views` and `contributes.viewsContainers`. */
export const VIEW_IDS = {
  container: 'nestro',
  packages: 'nestro.packagesView',
} as const;

/** `setContext` keys; the manifest's `when` and `enablement` clauses read them. */
export const CONTEXT_KEYS = {
  canUpdateVisiblePackages: 'nestro.canUpdateVisiblePackages',
  hasPackageFiles: 'nestro.hasPackageFiles',
  hasReadablePackageFiles: 'nestro.hasReadablePackageFiles',
  hasDependencyEntries: 'nestro.hasDependencyEntries',
  hasAuditableProjects: 'nestro.hasAuditableProjects',
  canRunInstall: 'nestro.canRunInstall',
  canRunAudit: 'nestro.canRunAudit',
  canSearchPackages: 'nestro.canSearchPackages',
  canFilterPackages: 'nestro.canFilterPackages',
  canPinAllVersions: 'nestro.canPinAllVersions',
  noWorkspace: 'nestro.noWorkspace',
  hasSearchQuery: 'nestro.hasSearchQuery',
} as const;

/** Tree item `contextValue` tokens; the manifest's `viewItem =~` patterns match the row tokens. */
export const CONTEXT_VALUE_TOKENS = {
  package: 'package',
  outdated: 'outdated',
  installing: 'installing',
  pinnable: 'pinnable',
  pinUnsupported: 'pin-unsupported',
  vulnerable: 'vulnerable',
  group: 'group',
  detail: 'detail',
  status: 'status',
  statusSearchActive: 'status-search-active',
  workspaceFolder: 'workspaceFolder',
} as const;