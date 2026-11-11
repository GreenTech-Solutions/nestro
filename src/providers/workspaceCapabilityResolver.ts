import { resolveAuditProjects } from '../clients';
import type { AuditProject } from '../clients';
import { logger, resolveYarnFamily } from '../utils';

/** Workspace actions derived from the loaded package manifests. */
export interface WorkspaceCapabilities {
  readonly hasPackageFiles: boolean;
  readonly hasReadablePackageFiles: boolean;
  readonly hasDependencyEntries: boolean;
  readonly hasAuditableProjects: boolean;
  readonly canRunInstall: boolean;
  readonly canRunAudit: boolean;
  readonly canSearchPackages: boolean;
  readonly canFilterPackages: boolean;
  readonly canPinAllVersions: boolean;
}

export const EMPTY_WORKSPACE_CAPABILITIES: WorkspaceCapabilities = Object.freeze({
  hasPackageFiles: false,
  hasReadablePackageFiles: false,
  hasDependencyEntries: false,
  hasAuditableProjects: false,
  canRunInstall: false,
  canRunAudit: false,
  canSearchPackages: false,
  canFilterPackages: false,
  canPinAllVersions: false,
});

export interface WorkspaceCapabilityResolverDependencies {
  readonly resolveAuditProjects: typeof resolveAuditProjects;
  readonly resolveYarnFamily: typeof resolveYarnFamily;
}

const DEFAULT_DEPENDENCIES: WorkspaceCapabilityResolverDependencies = {
  resolveAuditProjects,
  resolveYarnFamily,
};

/** Resolves which global package actions are supported by the loaded workspace. */
export class WorkspaceCapabilityResolver {
  constructor(
    private readonly dependencies: WorkspaceCapabilityResolverDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  async resolve(
    packageFilePaths: readonly string[],
    readablePackageFilePaths: readonly string[],
    entries: readonly { readonly packageFilePath: string }[],
  ): Promise<WorkspaceCapabilities> {
    const hasPackageFiles = packageFilePaths.length > 0;
    const hasReadablePackageFiles = readablePackageFilePaths.length > 0;
    const hasDependencyEntries = entries.length > 0;
    const hasAuditableProjects = hasReadablePackageFiles
      ? await this.resolveAuditableProjects(readablePackageFilePaths)
      : false;

    return {
      hasPackageFiles,
      hasReadablePackageFiles,
      hasDependencyEntries,
      hasAuditableProjects,
      canRunInstall: hasReadablePackageFiles,
      canRunAudit: hasAuditableProjects,
      canSearchPackages: hasDependencyEntries,
      canFilterPackages: hasDependencyEntries,
      canPinAllVersions: hasDependencyEntries,
    };
  }

  private async resolveAuditableProjects(packageFilePaths: readonly string[]): Promise<boolean> {
    try {
      const { projects } = await this.dependencies.resolveAuditProjects(packageFilePaths);
      for (const project of projects) {
        if (await this.isAuditableProject(project)) {
          return true;
        }
      }
      return false;
    }
    catch {
      logger.warn('Failed to resolve auditable workspace projects.');
      return false;
    }
  }

  private async isAuditableProject(project: AuditProject): Promise<boolean> {
    if (project.lockfilePath === undefined) {
      return false;
    }
    if (project.packageManager !== 'yarn') {
      return true;
    }
    try {
      const resolution = await this.dependencies.resolveYarnFamily(project.projectRoot);
      return resolution.family !== 'unknown';
    }
    catch {
      return false;
    }
  }
}