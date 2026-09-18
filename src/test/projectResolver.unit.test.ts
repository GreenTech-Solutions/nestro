import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { resolveAuditProjects, resolveMutationCoordinatorKey } from '../clients';

const fsMock = vi.hoisted(() => ({ realpath: vi.fn((value: string) => Promise.resolve(value)) }));

vi.mock('node:fs/promises', () => fsMock);

function mockWorkspaceFiles(files: Record<string, string>): void {
  vi.mocked(vscode.workspace.fs.readFile).mockImplementation((uri: vscode.Uri) => {
    const value = files[uri.fsPath];
    if (value === undefined) {
      return Promise.reject(new Error(`File not found: ${uri.fsPath}`));
    }
    return Promise.resolve(Buffer.from(value));
  });
}

function setWorkspaceFolders(paths: readonly string[]): void {
  Object.defineProperty(vscode.workspace, 'workspaceFolders', {
    configurable: true,
    value: paths.map(fsPath => ({ uri: { fsPath } })),
  });
  vi.mocked(vscode.workspace.getWorkspaceFolder).mockImplementation((uri: { fsPath: string }) =>
    vscode.workspace.workspaceFolders?.find(folder => uri.fsPath.startsWith(folder.uri.fsPath)));
}

describe('resolveAuditProjects()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.realpath.mockImplementation((value: string) => Promise.resolve(value));
    setWorkspaceFolders(['/workspace']);
    vi.mocked(vscode.workspace.fs.readFile).mockRejectedValue(new Error('not mocked'));
  });

  it('merges a child manifest into its ancestor lockfile project root', async () => {
    mockWorkspaceFiles({
      '/workspace/package.json': '{}',
      '/workspace/pnpm-lock.yaml': '',
      '/workspace/packages/app/package.json': '{}',
    });

    const { projects, rejected } = await resolveAuditProjects(['/workspace/packages/app/package.json']);

    expect(rejected).toEqual([]);
    expect(projects).toEqual([{
      projectRoot: '/workspace',
      workspaceFolder: '/workspace',
      packageManager: 'pnpm',
      lockfilePath: '/workspace/pnpm-lock.yaml',
      originManifests: ['/workspace/packages/app/package.json'],
    }]);
  });

  it('deduplicates two manifests that share the same ancestor lockfile graph into one project', async () => {
    mockWorkspaceFiles({
      '/workspace/package.json': '{}',
      '/workspace/pnpm-lock.yaml': '',
      '/workspace/packages/api/package.json': '{}',
      '/workspace/packages/ui/package.json': '{}',
    });

    const { projects, rejected } = await resolveAuditProjects([
      '/workspace/packages/ui/package.json',
      '/workspace/packages/api/package.json',
    ]);

    expect(rejected).toEqual([]);
    expect(projects).toHaveLength(1);
    expect(projects[0].projectRoot).toBe('/workspace');
    // Origin manifests come back sorted, independent of input order, so the
    // dedupe key stays stable across repeated resolver calls.
    expect(projects[0].originManifests).toEqual([
      '/workspace/packages/api/package.json',
      '/workspace/packages/ui/package.json',
    ]);
  });

  it('keeps two manifests as independent projects when neither carries any package-manager signal', async () => {
    mockWorkspaceFiles({
      '/workspace/apps/web/package.json': '{}',
      '/workspace/packages/ui/package.json': '{}',
    });

    const { projects, rejected } = await resolveAuditProjects([
      '/workspace/apps/web/package.json',
      '/workspace/packages/ui/package.json',
    ]);

    expect(rejected).toEqual([]);
    expect(projects).toHaveLength(2);
    expect(projects.map(project => project.projectRoot).sort((a, b) => a.localeCompare(b))).toEqual([
      '/workspace/apps/web',
      '/workspace/packages/ui',
    ]);
    for (const project of projects) {
      expect(project.packageManager).toBe('npm');
      expect(project.lockfilePath).toBeUndefined();
    }
  });

  it('prefers a child lockfile signal over an ancestor packageManager field', async () => {
    mockWorkspaceFiles({
      '/workspace/package.json': JSON.stringify({ packageManager: 'pnpm@9.0.0' }),
      '/workspace/packages/app/package.json': '{}',
      '/workspace/packages/app/yarn.lock': '# yarn lockfile v1\n',
    });

    const { projects } = await resolveAuditProjects(['/workspace/packages/app/package.json']);

    expect(projects).toEqual([{
      projectRoot: '/workspace/packages/app',
      workspaceFolder: '/workspace',
      packageManager: 'yarn',
      lockfilePath: '/workspace/packages/app/yarn.lock',
      originManifests: ['/workspace/packages/app/package.json'],
    }]);
  });

  it('reports a lockfile that exists alongside a winning packageManager field', async () => {
    mockWorkspaceFiles({
      '/workspace/package.json': JSON.stringify({ packageManager: 'npm@11.0.0' }),
      '/workspace/package-lock.json': '{}',
    });

    const { projects } = await resolveAuditProjects(['/workspace/package.json']);

    expect(projects).toEqual([{
      projectRoot: '/workspace',
      workspaceFolder: '/workspace',
      packageManager: 'npm',
      lockfilePath: '/workspace/package-lock.json',
      originManifests: ['/workspace/package.json'],
    }]);
  });

  it('merges two manifests whose signal roots canonicalize to the same real directory', async () => {
    mockWorkspaceFiles({
      '/workspace/pkg-a/package.json': JSON.stringify({ packageManager: 'pnpm@9.0.0' }),
      '/workspace/pkg-a/nested/package.json': '{}',
      '/workspace/pkg-b-symlink/package.json': JSON.stringify({ packageManager: 'pnpm@9.0.0' }),
    });
    fsMock.realpath.mockImplementation((value: string) => Promise.resolve(
      value === '/workspace/pkg-b-symlink' ? '/workspace/pkg-a' : value,
    ));

    const { projects, rejected } = await resolveAuditProjects([
      '/workspace/pkg-a/nested/package.json',
      '/workspace/pkg-b-symlink/package.json',
    ]);

    expect(rejected).toEqual([]);
    expect(projects).toHaveLength(1);
    expect(projects[0].projectRoot).toBe('/workspace/pkg-a');
    expect(projects[0].originManifests).toEqual([
      '/workspace/pkg-a/nested/package.json',
      '/workspace/pkg-b-symlink/package.json',
    ]);
  });

  it('rejects a project root whose canonical path escapes the owning workspace folder', async () => {
    mockWorkspaceFiles({
      '/workspace/vendor/package.json': JSON.stringify({ packageManager: 'pnpm@9.0.0' }),
      '/workspace/vendor/packages/app/package.json': '{}',
    });
    fsMock.realpath.mockImplementation((value: string) => Promise.resolve(
      value.startsWith('/workspace/vendor') ? `/outside${value}` : value,
    ));

    const { projects, rejected } = await resolveAuditProjects(['/workspace/vendor/packages/app/package.json']);

    expect(projects).toEqual([]);
    expect(rejected).toEqual([{
      packageFilePath: '/workspace/vendor/packages/app/package.json',
      reason: 'workspace-escape',
      detail: expect.stringContaining('/workspace/vendor/packages/app/package.json'),
    }]);
  });

  it('falls back to a manifest own directory when only its ancestor signal escapes the workspace', async () => {
    mockWorkspaceFiles({
      '/workspace/vendor/package.json': JSON.stringify({ packageManager: 'pnpm@9.0.0' }),
      '/workspace/vendor/packages/app/package.json': '{}',
    });
    fsMock.realpath.mockImplementation((value: string) => Promise.resolve(
      value === '/workspace/vendor' ? '/outside/vendor' : value,
    ));

    const { projects, rejected } = await resolveAuditProjects(['/workspace/vendor/packages/app/package.json']);

    expect(rejected).toEqual([]);
    expect(projects).toEqual([{
      projectRoot: '/workspace/vendor/packages/app',
      workspaceFolder: '/workspace',
      packageManager: 'npm',
      lockfilePath: undefined,
      originManifests: ['/workspace/vendor/packages/app/package.json'],
    }]);
  });

  it('rejects every manifest with no owning workspace folder, sorted for a stable snapshot', async () => {
    vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(undefined);
    mockWorkspaceFiles({
      '/outside/b/package.json': '{}',
      '/outside/a/package.json': '{}',
    });

    const { projects, rejected } = await resolveAuditProjects([
      '/outside/b/package.json',
      '/outside/a/package.json',
    ]);

    expect(projects).toEqual([]);
    expect(rejected).toEqual([
      { packageFilePath: '/outside/a/package.json', reason: 'no-owning-workspace', detail: expect.any(String) },
      { packageFilePath: '/outside/b/package.json', reason: 'no-owning-workspace', detail: expect.any(String) },
    ]);
  });

  it('rejects a cross-workspace collision instead of silently merging two workspace folders', async () => {
    setWorkspaceFolders(['/workspace-a', '/workspace-b']);
    mockWorkspaceFiles({
      '/workspace-a/package.json': JSON.stringify({ packageManager: 'pnpm@9.0.0' }),
      '/workspace-b/package.json': JSON.stringify({ packageManager: 'pnpm@9.0.0' }),
    });
    fsMock.realpath.mockImplementation((value: string) => Promise.resolve(
      value === '/workspace-b' ? '/workspace-a' : value,
    ));

    const { projects, rejected } = await resolveAuditProjects([
      '/workspace-a/package.json',
      '/workspace-b/package.json',
    ]);

    expect(projects).toHaveLength(1);
    expect(projects[0].originManifests).toEqual(['/workspace-a/package.json']);
    expect(rejected).toEqual([{
      packageFilePath: '/workspace-b/package.json',
      reason: 'cross-workspace-collision',
      detail: expect.any(String),
    }]);
  });

  it('returns projects sorted by canonical project root for a stable snapshot', async () => {
    mockWorkspaceFiles({
      '/workspace/b-app/package.json': '{}',
      '/workspace/a-app/package.json': '{}',
    });

    const { projects } = await resolveAuditProjects([
      '/workspace/b-app/package.json',
      '/workspace/a-app/package.json',
    ]);

    expect(projects.map(project => project.projectRoot)).toEqual([
      '/workspace/a-app',
      '/workspace/b-app',
    ]);
  });

  // N2(a)/N4: a realpath failure (ENOENT/ELOOP/EACCES) is a distinct, fail-closed
  // rejection reason from a proven symlink escape — the two causes must not be
  // reported to the user under the same label.
  it('rejects with an unresolvable-path reason when realpath fails, not a claimed workspace escape', async () => {
    mockWorkspaceFiles({
      '/workspace/broken/package.json': '{}',
    });
    fsMock.realpath.mockImplementation((value: string) => {
      if (value === '/workspace/broken') {
        return Promise.reject(Object.assign(new Error('too many levels of symbolic links'), { code: 'ELOOP' }));
      }
      return Promise.resolve(value);
    });

    const { projects, rejected } = await resolveAuditProjects(['/workspace/broken/package.json']);

    expect(projects).toEqual([]);
    expect(rejected).toEqual([{
      packageFilePath: '/workspace/broken/package.json',
      reason: 'unresolvable-path',
      detail: expect.any(String),
    }]);
  });

  // N2(b): the manifest's own directory can escape the workspace even when no
  // ancestor signal was ever found — a separate branch from the ancestor-signal-escaped
  // fallback covered above ("falls back to a manifest own directory…").
  it('rejects a workspace escape for a manifest with no ancestor package-manager signal at all', async () => {
    mockWorkspaceFiles({
      '/workspace/orphan/package.json': '{}',
    });
    fsMock.realpath.mockImplementation((value: string) => Promise.resolve(
      value === '/workspace/orphan' ? '/outside/orphan' : value,
    ));

    const { projects, rejected } = await resolveAuditProjects(['/workspace/orphan/package.json']);

    expect(projects).toEqual([]);
    expect(rejected).toEqual([{
      packageFilePath: '/workspace/orphan/package.json',
      reason: 'workspace-escape',
      detail: expect.any(String),
    }]);
  });

  // N3: containment must be checked before any file is read from a directory in the
  // fallback path. The manifest's own directory is necessarily read once already, as
  // part of the initial ancestor walk that discovers the (here, escaping) ancestor
  // signal in the first place — that read cannot be avoided without redesigning the
  // whole resolver, and is out of scope. What must not happen is a *second*,
  // redundant read of the same directory's package.json from inside the fallback
  // before its containment has been re-checked: canonicalizing first (and returning
  // immediately on failure) means the fallback's own signal detection never runs at
  // all for a directory proven to escape.
  it('does not re-read a manifest directory a second time in the fallback before checking its containment', async () => {
    mockWorkspaceFiles({
      '/workspace/vendor3/package.json': JSON.stringify({ packageManager: 'pnpm@9.0.0' }),
      '/workspace/vendor3/packages/app/package.json': '{}',
    });
    fsMock.realpath.mockImplementation((value: string) => Promise.resolve(
      value.startsWith('/workspace/vendor3') ? `/outside${value}` : value,
    ));
    const readFileSpy = vi.mocked(vscode.workspace.fs.readFile);

    const { rejected } = await resolveAuditProjects(['/workspace/vendor3/packages/app/package.json']);

    expect(rejected).toEqual([{
      packageFilePath: '/workspace/vendor3/packages/app/package.json',
      reason: 'workspace-escape',
      detail: expect.any(String),
    }]);
    // Exactly one read of the manifest's own package.json (from the initial ancestor
    // walk) — a second read here would mean the fallback ran its own signal detection
    // before its canonicalizeRoot() call had already proven the directory escapes.
    const manifestOwnPackageJsonReads = readFileSpy.mock.calls.filter(([uri]) =>
      (uri as vscode.Uri).fsPath === '/workspace/vendor3/packages/app/package.json').length;
    expect(manifestOwnPackageJsonReads).toBe(1);
  });

  // N7: the winner of a cross-workspace collision must not depend on the order
  // findFiles() happens to return manifests in, since that order is not guaranteed.
  it('resolves a cross-workspace collision deterministically regardless of input order', async () => {
    setWorkspaceFolders(['/workspace-a', '/workspace-b']);
    mockWorkspaceFiles({
      '/workspace-a/package.json': JSON.stringify({ packageManager: 'pnpm@9.0.0' }),
      '/workspace-b/package.json': JSON.stringify({ packageManager: 'pnpm@9.0.0' }),
    });
    fsMock.realpath.mockImplementation((value: string) => Promise.resolve(
      value === '/workspace-b' ? '/workspace-a' : value,
    ));

    const forward = await resolveAuditProjects(['/workspace-a/package.json', '/workspace-b/package.json']);
    const reversed = await resolveAuditProjects(['/workspace-b/package.json', '/workspace-a/package.json']);

    expect(forward.rejected).toEqual(reversed.rejected);
    expect(forward.projects).toEqual(reversed.projects);
    expect(forward.rejected[0]?.packageFilePath).toBe('/workspace-b/package.json');
  });
});

describe('resolveMutationCoordinatorKey()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.realpath.mockImplementation((value: string) => Promise.resolve(value));
    setWorkspaceFolders(['/workspace']);
    vi.mocked(vscode.workspace.fs.readFile).mockRejectedValue(new Error('not mocked'));
  });

  it('keys by the ancestor lockfile project root, not the manifest\'s own directory', async () => {
    mockWorkspaceFiles({
      '/workspace/package.json': '{}',
      '/workspace/pnpm-lock.yaml': '',
      '/workspace/packages/app/package.json': '{}',
    });

    const key = await resolveMutationCoordinatorKey('/workspace/packages/app/package.json');

    expect(key).toBe('/workspace');
  });

  it('gives two manifests sharing one ancestor lockfile graph the same key', async () => {
    mockWorkspaceFiles({
      '/workspace/package.json': '{}',
      '/workspace/pnpm-lock.yaml': '',
      '/workspace/packages/api/package.json': '{}',
      '/workspace/packages/ui/package.json': '{}',
    });

    const apiKey = await resolveMutationCoordinatorKey('/workspace/packages/api/package.json');
    const uiKey = await resolveMutationCoordinatorKey('/workspace/packages/ui/package.json');

    expect(apiKey).toBe(uiKey);
    expect(apiKey).toBe('/workspace');
  });

  it('gives two manifests with no shared ancestor lockfile signal independent keys', async () => {
    mockWorkspaceFiles({
      '/workspace/packages/app-a/package.json': '{}',
      '/workspace/packages/app-b/package.json': '{}',
    });

    const keyA = await resolveMutationCoordinatorKey('/workspace/packages/app-a/package.json');
    const keyB = await resolveMutationCoordinatorKey('/workspace/packages/app-b/package.json');

    expect(keyA).not.toBe(keyB);
    expect(keyA).toBe('/workspace/packages/app-a');
    expect(keyB).toBe('/workspace/packages/app-b');
  });

  it('falls back to the manifest directory when no workspace folder owns it', async () => {
    setWorkspaceFolders([]);
    mockWorkspaceFiles({ '/elsewhere/package.json': '{}' });

    const key = await resolveMutationCoordinatorKey('/elsewhere/package.json');

    expect(key).toBe('/elsewhere');
  });

  it('falls back to the manifest directory when canonicalization fails (workspace escape)', async () => {
    mockWorkspaceFiles({ '/workspace/vendor/package.json': '{}' });
    fsMock.realpath.mockImplementation((value: string) => Promise.resolve(
      value.startsWith('/workspace/vendor') ? `/outside${value}` : value,
    ));

    const key = await resolveMutationCoordinatorKey('/workspace/vendor/package.json');

    expect(key).toBe('/workspace/vendor');
  });

  it('picks the deepest workspace folder when a manifest is canonically contained by more than one', async () => {
    setWorkspaceFolders(['/workspace', '/workspace/nested']);
    mockWorkspaceFiles({
      '/workspace/pnpm-lock.yaml': '',
      '/workspace/nested/pkg/package.json': '{}',
    });

    const key = await resolveMutationCoordinatorKey('/workspace/nested/pkg/package.json');

    // If the shallower '/workspace' folder had won, the ancestor walk would reach
    // '/workspace/pnpm-lock.yaml' and key on '/workspace' instead.
    expect(key).toBe('/workspace/nested/pkg');
  });

  it('ignores a workspace folder whose own path cannot be canonicalized and still matches on the rest', async () => {
    setWorkspaceFolders(['/workspace', '/broken-folder']);
    mockWorkspaceFiles({ '/workspace/pkg/package.json': '{}' });
    fsMock.realpath.mockImplementation((value: string) => (
      value === '/broken-folder' ? Promise.reject(new Error('ENOENT')) : Promise.resolve(value)
    ));

    const key = await resolveMutationCoordinatorKey('/workspace/pkg/package.json');

    expect(key).toBe('/workspace/pkg');
  });

  it('falls back to the manifest directory when a found owning workspace folder still fails project resolution', async () => {
    mockWorkspaceFiles({ '/workspace/broken/package.json': '{}' });
    // The manifest file resolves fine, but its own directory does not (e.g. removed
    // between the two `realpath` calls) — a failure distinct from having no owner at all.
    fsMock.realpath.mockImplementation((value: string) => (
      value === '/workspace/broken' ? Promise.reject(new Error('ELOOP')) : Promise.resolve(value)
    ));

    const key = await resolveMutationCoordinatorKey('/workspace/broken/package.json');

    expect(key).toBe('/workspace/broken');
  });

  it('gives the same key for a canonical manifest path and a raw path reached through a symlinked workspace folder', async () => {
    // The workspace folder is opened at a symlinked path (e.g. macOS `/tmp` ->
    // `/private/tmp`, or a project symlink); VS Code reports it lexically as opened,
    // never resolved. One call site already has a realpath-resolved manifest path
    // (`packageIdentity.ts`); another has a raw path straight from `findFiles()`. Both
    // must resolve to the same project root, not just the same manifest.
    const lexicalRoot = '/Users/me/proj';
    const canonicalRoot = '/Volumes/Code/proj';
    const toCanonical = (value: string): string =>
      value === lexicalRoot || value.startsWith(`${lexicalRoot}/`)
        ? canonicalRoot + value.slice(lexicalRoot.length)
        : value;

    fsMock.realpath.mockImplementation((value: string) => Promise.resolve(toCanonical(value)));
    setWorkspaceFolders([lexicalRoot]);
    const canonicalFiles: Record<string, string> = {
      [`${canonicalRoot}/package.json`]: '{}',
      [`${canonicalRoot}/pnpm-lock.yaml`]: '',
      [`${canonicalRoot}/packages/api/package.json`]: '{}',
    };
    vi.mocked(vscode.workspace.fs.readFile).mockImplementation((uri: vscode.Uri) => {
      const value = canonicalFiles[toCanonical(uri.fsPath)];
      return value === undefined
        ? Promise.reject(new Error(`File not found: ${uri.fsPath}`))
        : Promise.resolve(Buffer.from(value));
    });

    const canonicalKey = await resolveMutationCoordinatorKey(`${canonicalRoot}/packages/api/package.json`);
    const rawKey = await resolveMutationCoordinatorKey(`${lexicalRoot}/packages/api/package.json`);

    expect(rawKey).toBe(canonicalKey);
    expect(canonicalKey).toBe(canonicalRoot);
  });
});