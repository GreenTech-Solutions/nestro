import { describe, expect, it, vi } from 'vitest';
import type { AuditProject } from '../clients';
import {
  EMPTY_WORKSPACE_CAPABILITIES,
  WorkspaceCapabilityResolver,
} from '../providers/workspaceCapabilityResolver';

function createProject(overrides: Partial<AuditProject> = {}): AuditProject {
  return {
    projectRoot: '/workspace',
    workspaceFolder: '/workspace',
    packageManager: 'npm',
    lockfilePath: '/workspace/package-lock.json',
    originManifests: ['/workspace/package.json'],
    ...overrides,
  };
}

describe('WorkspaceCapabilityResolver', () => {
  it('derives action capabilities from manifests and a supported project', async () => {
    const project = createProject();
    const resolver = new WorkspaceCapabilityResolver({
      resolveAuditProjects: vi.fn(() => Promise.resolve({ projects: [project], rejected: [] })),
      resolveYarnFamily: vi.fn(() => Promise.resolve({ family: 'unknown' as const, source: 'version-probe' as const })),
    });

    await expect(resolver.resolve(
      ['/workspace/package.json'],
      ['/workspace/package.json'],
      [{ packageFilePath: '/workspace/package.json' }],
    )).resolves.toEqual({
      ...EMPTY_WORKSPACE_CAPABILITIES,
      hasPackageFiles: true,
      hasReadablePackageFiles: true,
      hasDependencyEntries: true,
      hasAuditableProjects: true,
      canRunInstall: true,
      canRunAudit: true,
      canSearchPackages: true,
      canFilterPackages: true,
      canPinAllVersions: true,
    });
  });

  it('requires a known Yarn family before enabling audit', async () => {
    const resolver = new WorkspaceCapabilityResolver({
      resolveAuditProjects: vi.fn(() => Promise.resolve({
        projects: [createProject({ packageManager: 'yarn' })],
        rejected: [],
      })),
      resolveYarnFamily: vi.fn(() => Promise.resolve({ family: 'unknown' as const, source: 'version-probe' as const })),
    });

    await expect(resolver.resolve(
      ['/workspace/package.json'],
      ['/workspace/package.json'],
      [],
    )).resolves.toMatchObject({
      hasAuditableProjects: false,
      canRunAudit: false,
    });
  });

  it('keeps non-auditable manifests from enabling audit', async () => {
    const resolver = new WorkspaceCapabilityResolver({
      resolveAuditProjects: vi.fn(() => Promise.resolve({
        projects: [createProject({ lockfilePath: undefined })],
        rejected: [],
      })),
      resolveYarnFamily: vi.fn(),
    });

    await expect(resolver.resolve(['/workspace/package.json'], ['/workspace/package.json'], []))
      .resolves.toMatchObject({ hasAuditableProjects: false, canRunAudit: false });
  });
});