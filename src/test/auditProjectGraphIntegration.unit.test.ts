import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { FilterManager, PackagesProvider } from '../providers';
import { readAllWorkspaceDependencies } from '../utils';

// N12 regression guard: every other provider-level suite (packagesProvider.unit.test.ts,
// auditResultContract.unit.test.ts) mocks `resolveAuditProjects`, so none of them prove
// that the REAL resolver, wired to the REAL provider, actually collapses several
// manifests that share one lock file graph into a single audit run — the AUD-06 DoD
// ("one lock file graph is audited exactly once"). This suite keeps `resolveAuditProjects`
// and `PackagesProvider.runAudit()` both real; only `ClientManager.createClient()` (the
// audit subprocess boundary) is stubbed, so no real npm/pnpm process ever runs.

const fsMock = vi.hoisted(() => ({ realpath: vi.fn((value: string) => Promise.resolve(value)) }));
vi.mock('node:fs/promises', () => fsMock);

const createClientMock = vi.hoisted(() => vi.fn());

vi.mock('../clients', async () => {
  const actual = await vi.importActual<typeof import('../clients')>('../clients');
  return {
    ...actual,
    ClientManager: vi.fn(function (this: { createClient: typeof createClientMock }) {
      this.createClient = createClientMock;
    }),
  };
});

vi.mock('../utils', async () => {
  const actual = await vi.importActual<typeof import('../utils')>('../utils');
  return {
    ...actual,
    readAllWorkspaceDependencies: vi.fn(),
  };
});

function mockWorkspaceFiles(files: Record<string, string>): void {
  vi.mocked(vscode.workspace.fs.readFile).mockImplementation((uri: vscode.Uri) => {
    const value = files[uri.fsPath];
    if (value === undefined) {
      return Promise.reject(new Error(`File not found: ${uri.fsPath}`));
    }
    return Promise.resolve(Buffer.from(value));
  });
}

describe('audit project graph integration (real resolver + real provider)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.realpath.mockImplementation((value: string) => Promise.resolve(value));
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      configurable: true,
      value: [{ uri: { fsPath: '/workspace' } }],
    });
    vi.mocked(vscode.workspace.getWorkspaceFolder).mockImplementation((uri: { fsPath: string }) =>
      vscode.workspace.workspaceFolders?.find(folder => uri.fsPath.startsWith(folder.uri.fsPath)));
    createClientMock.mockReset();
  });

  it('audits a pnpm monorepo lock file graph exactly once across four manifests', async () => {
    mockWorkspaceFiles({
      '/workspace/package.json': '{}',
      '/workspace/pnpm-lock.yaml': '',
      '/workspace/packages/api/package.json': '{}',
      '/workspace/packages/ui/package.json': '{}',
      '/workspace/packages/cli/package.json': '{}',
    });
    vi.mocked(readAllWorkspaceDependencies).mockResolvedValue([
      { name: 'react', current: '18.0.0', dev: false, versionPrefix: '', packageFilePath: '/workspace/package.json' },
      { name: 'react', current: '18.0.0', dev: false, versionPrefix: '', packageFilePath: '/workspace/packages/api/package.json' },
      { name: 'react', current: '18.0.0', dev: false, versionPrefix: '', packageFilePath: '/workspace/packages/ui/package.json' },
      { name: 'react', current: '18.0.0', dev: false, versionPrefix: '', packageFilePath: '/workspace/packages/cli/package.json' },
    ]);
    createClientMock.mockReturnValue({ runAudit: vi.fn().mockResolvedValue(new Map()) });

    const provider = new PackagesProvider(new FilterManager('all'));
    await provider.loadPackages();
    await provider.runAudit();

    // Baseline would have created a client once per manifest (4 times); the real
    // resolver merges all four into one project rooted at the shared pnpm-lock.yaml
    // directory, so createClient must be called exactly once.
    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(createClientMock).toHaveBeenCalledWith('pnpm', '/workspace');

    const [summary] = provider.getAuditProjects();
    expect(summary.project.originManifests).toEqual([
      '/workspace/package.json',
      '/workspace/packages/api/package.json',
      '/workspace/packages/cli/package.json',
      '/workspace/packages/ui/package.json',
    ]);
  });
});