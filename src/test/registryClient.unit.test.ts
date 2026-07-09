import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import * as https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPackageVersions, selectVersionsForPicker } from '../utils/registryClient';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));
vi.mock('node:https', () => ({
  get: vi.fn(),
}));
vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/home/user'),
}));

interface MockClientRequest extends EventEmitter {
  destroy: ReturnType<typeof vi.fn>;
  setTimeout: ReturnType<typeof vi.fn>;
}

describe('fetchPackageVersions()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readFile).mockRejectedValue(new Error('missing npmrc'));
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      configurable: true,
      value: [{ uri: { fsPath: '/workspace' } }],
    });
    vi.mocked(vscode.workspace.getWorkspaceFolder).mockImplementation((uri: { fsPath: string }) => {
      return vscode.workspace.workspaceFolders?.find(folder => uri.fsPath.startsWith(`${folder.uri.fsPath}/`));
    });
  });

  it('parses dist-tags and versions from the npm registry response', async () => {
    mockRegistryResponse(JSON.stringify({
      'dist-tags': { latest: '18.2.0', next: '19.0.0-rc.1' },
      versions: {
        '18.0.0': {},
        '18.2.0': {},
      },
    }));

    await expect(fetchPackageVersions('react')).resolves.toEqual({
      tags: { latest: '18.2.0', next: '19.0.0-rc.1' },
      versions: ['18.2.0', '18.0.0'],
    });
    expectRegistryUrl('https://registry.npmjs.org/react');
  });

  it('uses the project .npmrc default registry when present', async () => {
    mockNpmrcFiles({
      '/workspace/.npmrc': 'registry=https://registry.example.com/npm/',
    });
    mockRegistryResponse(JSON.stringify({
      'dist-tags': {},
      versions: { '1.0.0': {} },
    }));

    await expect(fetchPackageVersions('react', '/workspace/package.json')).resolves.toEqual({
      tags: {},
      versions: ['1.0.0'],
    });
    expectRegistryUrl('https://registry.example.com/npm/react');
  });

  it('uses the user .npmrc default registry when project config is missing', async () => {
    mockNpmrcFiles({
      '/home/user/.npmrc': 'registry=https://user-registry.example.com',
    });
    mockRegistryResponse(JSON.stringify({
      'dist-tags': {},
      versions: { '1.0.0': {} },
    }));

    await fetchPackageVersions('react', '/workspace/package.json');

    expectRegistryUrl('https://user-registry.example.com/react');
  });

  it('prefers project .npmrc over user .npmrc for matching keys', async () => {
    mockNpmrcFiles({
      '/home/user/.npmrc': 'registry=https://user-registry.example.com',
      '/workspace/.npmrc': 'registry=https://project-registry.example.com',
    });
    mockRegistryResponse(JSON.stringify({
      'dist-tags': {},
      versions: { '1.0.0': {} },
    }));

    await fetchPackageVersions('react', '/workspace/package.json');

    expectRegistryUrl('https://project-registry.example.com/react');
  });

  it('uses scoped .npmrc registries for scoped packages', async () => {
    mockNpmrcFiles({
      '/workspace/.npmrc': [
        'registry=https://registry.example.com',
        '@private:registry=https://private.example.com/npm/',
      ].join('\n'),
    });
    mockRegistryResponse(JSON.stringify({
      'dist-tags': {},
      versions: { '1.0.0': {} },
    }));

    await fetchPackageVersions('@private/pkg', '/workspace/package.json');

    expectRegistryUrl('https://private.example.com/npm/@private%2Fpkg');
  });

  it('uses the owning workspace .npmrc in a multi-root workspace', async () => {
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      configurable: true,
      value: [
        { uri: { fsPath: '/workspace/app-one' } },
        { uri: { fsPath: '/workspace/app-two' } },
      ],
    });
    mockNpmrcFiles({
      '/workspace/app-one/.npmrc': 'registry=https://one.example.com',
      '/workspace/app-two/.npmrc': 'registry=https://two.example.com',
    });
    mockRegistryResponse(JSON.stringify({
      'dist-tags': {},
      versions: { '1.0.0': {} },
    }));
    mockRegistryResponse(JSON.stringify({
      'dist-tags': {},
      versions: { '2.0.0': {} },
    }));

    await fetchPackageVersions('first-package', '/workspace/app-one/package.json');
    await fetchPackageVersions('second-package', '/workspace/app-two/packages/web/package.json');

    expect(vi.mocked(https.get).mock.calls[0][0]).toBe('https://one.example.com/first-package');
    expect(vi.mocked(https.get).mock.calls[1][0]).toBe('https://two.example.com/second-package');
  });

  it('uses a scoped registry from the owning workspace in multi-root mode', async () => {
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      configurable: true,
      value: [
        { uri: { fsPath: '/workspace/public-app' } },
        { uri: { fsPath: '/workspace/private-app' } },
      ],
    });
    mockNpmrcFiles({
      '/workspace/public-app/.npmrc': '@private:registry=https://wrong.example.com',
      '/workspace/private-app/.npmrc': '@private:registry=https://private.example.com/npm/',
    });
    mockRegistryResponse(JSON.stringify({
      'dist-tags': {},
      versions: { '1.0.0': {} },
    }));

    await fetchPackageVersions('@private/pkg', '/workspace/private-app/package.json');

    expectRegistryUrl('https://private.example.com/npm/@private%2Fpkg');
    expect(readFile).not.toHaveBeenCalledWith('/workspace/public-app/.npmrc', 'utf8');
  });

  it('rejects on network errors', async () => {
    const error = new Error('network down');
    vi.mocked(https.get).mockImplementationOnce(() => {
      const request = createMockRequest();
      process.nextTick(() => {
        request.emit('error', error);
      });
      return toClientRequest(request);
    });

    await expect(fetchPackageVersions('react')).rejects.toThrow('network down');
  });

  it('rejects 404 registry responses with a descriptive status error', async () => {
    mockRegistryResponse(JSON.stringify({ error: 'Not found' }), 404);

    await expect(fetchPackageVersions('missing-package')).rejects.toThrow(
      'npm registry responded with HTTP 404 for missing-package',
    );
  });

  it('rejects 5xx registry responses with a descriptive status error', async () => {
    mockRegistryResponse(JSON.stringify({ error: 'Internal Server Error' }), 503);

    await expect(fetchPackageVersions('@scope/package')).rejects.toThrow(
      'npm registry responded with HTTP 503 for @scope/package',
    );
  });

  it('sets a registry request timeout and rejects with package context', async () => {
    const request = createMockRequest();
    vi.mocked(https.get).mockImplementationOnce(() => {
      process.nextTick(() => {
        request.emit('timeout');
      });
      return toClientRequest(request);
    });

    await expect(fetchPackageVersions('react')).rejects.toThrow(
      'npm registry request timed out after 15000ms for react',
    );
    expect(request.setTimeout).toHaveBeenCalledWith(15000);
    expect(request.destroy).toHaveBeenCalledWith(expect.objectContaining({
      message: 'npm registry request timed out after 15000ms for react',
    }));
  });

  it('rejects oversized registry responses before unbounded buffering', async () => {
    const request = createMockRequest();
    vi.mocked(https.get).mockImplementationOnce((_url, _options, callback) => {
      const response = new EventEmitter() as IncomingMessage;
      response.statusCode = 200;
      process.nextTick(() => {
        callback?.(response);
        response.emit('data', Buffer.alloc((5 * 1024 * 1024) + 1));
        response.emit('end');
      });
      return toClientRequest(request);
    });

    await expect(fetchPackageVersions('large-package')).rejects.toThrow(
      'npm registry response exceeded 5242880 bytes for large-package',
    );
    expect(request.destroy).toHaveBeenCalledWith(expect.objectContaining({
      message: 'npm registry response exceeded 5242880 bytes for large-package',
    }));
  });
});

describe('selectVersionsForPicker()', () => {
  it('returns the full list sorted by semantic version precedence', () => {
    expect(selectVersionsForPicker(
      ['1.0.0', '10.0.0', '2.0.0-beta.1', '2.0.0'],
      {},
      '1.0.0',
      true,
    )).toEqual([
      '10.0.0',
      '2.0.0',
      '2.0.0-beta.1',
      '1.0.0',
    ]);
  });

  it('filters prereleases when the setting is disabled', () => {
    expect(selectVersionsForPicker(
      ['2.0.0-beta.1', '1.2.0', '1.1.0-alpha.1', '1.0.0'],
      {},
      '1.0.0',
      false,
    )).toEqual([
      '1.2.0',
      '1.0.0',
    ]);
  });

  it('keeps only the current prerelease visible when filtering', () => {
    expect(selectVersionsForPicker(
      ['2.0.0-beta.2', '2.0.0-beta.1', '1.2.0', '1.0.0'],
      { next: '2.0.0-beta.2' },
      '2.0.0-beta.1',
      false,
    )).toEqual([
      '2.0.0-beta.1',
      '1.2.0',
      '1.0.0',
    ]);
  });
});

function mockRegistryResponse(body: string, statusCode = 200): void {
  vi.mocked(https.get).mockImplementationOnce((_url, _options, callback) => {
    const response = new EventEmitter() as IncomingMessage;
    response.statusCode = statusCode;
    process.nextTick(() => {
      callback?.(response);
      response.emit('data', body);
      response.emit('end');
    });
    return toClientRequest(createMockRequest());
  });
}

function mockNpmrcFiles(files: Record<string, string>): void {
  vi.mocked(readFile).mockImplementation((filePath) => {
    const value = files[String(filePath)];

    if (value === undefined) {
      return Promise.reject(new Error(`File not found: ${String(filePath)}`));
    }

    return Promise.resolve(value);
  });
}

function expectRegistryUrl(url: string): void {
  expect(vi.mocked(https.get).mock.calls[0][0]).toBe(url);
}

function createMockRequest(): MockClientRequest {
  const request = new EventEmitter() as MockClientRequest;
  request.destroy = vi.fn();
  request.setTimeout = vi.fn();
  return request;
}

function toClientRequest(request: MockClientRequest): ClientRequest {
  return request as unknown as ClientRequest;
}