import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { switchDepTypeCommand } from '../commands/switchDepType';
import { PackageItem, PackagesProvider } from '../providers';
import type { ResolvedPackageItem } from '../providers';

const malformedCommandCases: readonly [string, string, unknown, string][] = [
  ['source', 'number', 7, '<number>'],
  ['source', 'null', null, '<null>'],
  ['source', 'object', { version: '7', path: '/secret/package.json' }, '<object>'],
  ['source', 'array', ['7'], '<array>'],
  ['source', 'boolean', true, '<boolean>'],
  ['source', 'control and ANSI', '\u0000\u001b[31munsafe\u001b[0m\n', ' unsafe '],
  ['source', 'long string', 'x'.repeat(300), 'x'.repeat(240)],
  ['target', 'number', 7, '<number>'],
  ['target', 'null', null, '<null>'],
  ['target', 'object', { version: '7', path: '/secret/package.json' }, '<object>'],
  ['target', 'array', ['7'], '<array>'],
  ['target', 'boolean', true, '<boolean>'],
  ['target', 'control and ANSI', '\u0000\u001b[31munsafe\u001b[0m\n', ' unsafe '],
  ['target', 'long string', 'x'.repeat(300), 'x'.repeat(240)],
];

vi.mock('../clients', async () => {
  const actual = await vi.importActual<typeof import('../clients')>('../clients');
  return {
    ...actual,
    resolveMutationCoordinatorKey: vi.fn(() => '/workspace'),
  };
});

const identityMocks = vi.hoisted(() => {
  const capability: ResolvedPackageItem = {
    item: {
      packageName: 'pkg',
      currentVersion: '^1.2.3',
      latest: undefined,
      updateType: 'none',
      operation: undefined,
      vulnerabilitySeverity: undefined,
      packageFilePath: '/workspace/package.json',
      dev: false,
      versionPrefix: '',
    },
    identity: {
      packageName: 'pkg',
      packageFilePath: '/workspace/package.json',
      section: 'dependencies',
    },
    packageFilePath: '/workspace/package.json',
    packageDirectory: '/workspace',
    workspaceFolderPath: '/workspace',
    fileStamp: { dev: 1, ino: 1, size: 1, mtimeMs: 1 },
    manifestDigest: 'digest',
    snapshotGeneration: 1,
  };
  return {
    capability,
    resolveCommandPackageItem: vi.fn(() => capability),
    revalidateCommandPackageItem: vi.fn(() => capability),
  };
});

vi.mock('../commands/packageIdentity', () => identityMocks);

describe('switchDepTypeCommand() writer boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(vscode.workspace.fs.readFile).mockReset();
    vi.mocked(vscode.workspace.fs.writeFile).mockReset().mockResolvedValue(undefined);
    vi.mocked(vscode.window.showErrorMessage).mockReset();
  });

  it.each([
    ['changed', { dependencies: { pkg: '~2.0.0' } }, '^1.2.3', '~2.0.0'],
    ['removed', { dependencies: {} }, '^1.2.3', '<missing>'],
  ] as const)('rejects a source %s after final revalidation without writing or reloading', async (_label, nextManifest, expectedSourceSpec, actualSourceSpec) => {
    let manifest: Manifest = { dependencies: { pkg: '^1.2.3' } };
    const provider = makeProvider(() => {
      manifest = nextManifest;
    });
    vi.mocked(vscode.workspace.fs.readFile).mockImplementation(() => Promise.resolve(
      Buffer.from(JSON.stringify(manifest)),
    ));

    await switchDepTypeCommand(new PackageItem('pkg', '^1.2.3', undefined, 'none'), provider);

    expect(identityMocks.revalidateCommandPackageItem).toHaveBeenCalledTimes(1);
    expect(vscode.workspace.fs.readFile).toHaveBeenCalledTimes(1);
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(provider.loadPackages).not.toHaveBeenCalled();
    expect(vscode.l10n.t).toHaveBeenCalledWith(
      'Cannot switch {0}: source spec changed from {1} to {2}.',
      'pkg',
      expectedSourceSpec,
      actualSourceSpec,
    );
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      `${vscode.l10n.t('Nestro: ')}${vscode.l10n.t(
        'Cannot switch {0}: source spec changed from {1} to {2}.',
        'pkg',
        expectedSourceSpec,
        actualSourceSpec,
      )}`,
    );
  });

  it.each([
    ['same', '^1.2.3'],
    ['different', '~2.0.0'],
  ] as const)('reports a %s-spec target collision without writing or reloading', async (_label, targetSpec) => {
    const manifest: Manifest = {
      dependencies: { pkg: '^1.2.3' },
      devDependencies: { pkg: targetSpec },
    };
    const provider = makeProvider(() => {});
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify(manifest)));

    await switchDepTypeCommand(new PackageItem('pkg', '^1.2.3', undefined, 'none'), provider);

    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(provider.loadPackages).not.toHaveBeenCalled();
    expect(vscode.l10n.t).toHaveBeenCalledWith(
      'Cannot switch {0}: source spec {1} conflicts with target spec {2}.',
      'pkg',
      '^1.2.3',
      targetSpec,
    );
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      `${vscode.l10n.t('Nestro: ')}${vscode.l10n.t(
        'Cannot switch {0}: source spec {1} conflicts with target spec {2}.',
        'pkg',
        '^1.2.3',
        targetSpec,
      )}`,
    );
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalledWith(expect.stringContaining('/workspace/package.json'));
  });

  it.each(malformedCommandCases)('reports a malformed %s %s spec as one safe typed conflict', async (side, _label, malformedSpec, safeSpec) => {
    const manifest: Manifest = side === 'source'
      ? { dependencies: { pkg: malformedSpec } }
      : {
          dependencies: { pkg: '^1.2.3' },
          devDependencies: { pkg: malformedSpec },
        };
    const provider = makeProvider(() => {});
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify(manifest)));

    await switchDepTypeCommand(new PackageItem('pkg', '^1.2.3', undefined, 'none'), provider);

    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(provider.loadPackages).not.toHaveBeenCalled();
    const messageKey = side === 'source'
      ? 'Cannot switch {0}: source spec changed from {1} to {2}.'
      : 'Cannot switch {0}: source spec {1} conflicts with target spec {2}.';
    const messageArguments = ['pkg', '^1.2.3', safeSpec] as const;
    expect(vscode.l10n.t).toHaveBeenCalledWith(messageKey, ...messageArguments);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
    const message = String(vi.mocked(vscode.window.showErrorMessage).mock.calls[0]?.[0]);
    const localizedMessage = vscode.l10n.t(messageKey, ...messageArguments);
    const prefix = vscode.l10n.t('Nestro: ');
    if (_label === 'long string') {
      expect(message.length).toBeLessThanOrEqual(240);
      expect(message.startsWith(`${prefix}${localizedMessage.slice(0, 32)}`)).toBe(true);
      expect(message).toMatch(/x/);
    }
    else {
      expect(message).toBe(`${prefix}${localizedMessage}`);
      expect(message).toContain(side === 'source' ? `to ${safeSpec}` : `target spec ${safeSpec}`);
    }
    expect(message).not.toContain('/workspace/package.json');
    expect(message).not.toContain('/secret/package.json');
    expect(message).not.toMatch(/[\u0000-\u001f\u007f]/);
  });
});

interface Manifest {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

function makeProvider(onBeforeWrite: () => void): PackagesProvider {
  const provider = {
    withWriteSuppressed: vi.fn(async (fn: () => Promise<unknown>) => {
      onBeforeWrite();
      return await fn();
    }),
    loadPackages: vi.fn(),
    markPackageUpdatingForCapability: vi.fn((currentCapability: ResolvedPackageItem) => currentCapability),
  } as unknown as PackagesProvider;
  return provider;
}