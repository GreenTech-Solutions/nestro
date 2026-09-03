import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import * as https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchPackageMetadataFromRegistry,
  parseNpmRegistryMetadata,
  selectVersionsForPicker,
} from '../utils/registryClient';

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

describe('fetchPackageMetadataFromRegistry()', () => {
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

    await expect(fetchPackageMetadataFromRegistry('react')).resolves.toEqual({
      kind: 'success',
      result: {
        distTags: { latest: '18.2.0', next: '19.0.0-rc.1' },
        publishTimes: { kind: 'not-provided' },
        versions: ['18.2.0', '18.0.0'],
      },
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

    await expect(fetchPackageMetadataFromRegistry('react', '/workspace/package.json')).resolves.toMatchObject({
      kind: 'success',
      result: { versions: ['1.0.0'] },
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

    await fetchPackageMetadataFromRegistry('react', '/workspace/package.json');

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

    await fetchPackageMetadataFromRegistry('react', '/workspace/package.json');

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

    await fetchPackageMetadataFromRegistry('@private/pkg', '/workspace/package.json');

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

    await fetchPackageMetadataFromRegistry('first-package', '/workspace/app-one/package.json');
    await fetchPackageMetadataFromRegistry('second-package', '/workspace/app-two/packages/web/package.json');

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

    await fetchPackageMetadataFromRegistry('@private/pkg', '/workspace/private-app/package.json');

    expectRegistryUrl('https://private.example.com/npm/@private%2Fpkg');
    expect(readFile).not.toHaveBeenCalledWith('/workspace/public-app/.npmrc', 'utf8');
  });

  it('returns a transport outcome for network errors', async () => {
    const request = createMockRequest();
    vi.mocked(https.get).mockImplementationOnce(() => {
      process.nextTick(() => request.emit('error', new Error('network down')));
      return toClientRequest(request);
    });

    await expect(fetchPackageMetadataFromRegistry('react')).resolves.toEqual({
      kind: 'transport-error',
      reason: 'request',
    });
  });

  it('returns a transport outcome with the HTTP status for a missing package', async () => {
    mockRegistryResponse(JSON.stringify({ error: 'Not found' }), 404);

    await expect(fetchPackageMetadataFromRegistry('missing-package')).resolves.toEqual({
      kind: 'transport-error',
      reason: 'http-status',
      statusCode: 404,
    });
  });

  it('returns a transport outcome with the HTTP status for a server failure', async () => {
    mockRegistryResponse(JSON.stringify({ error: 'Internal Server Error' }), 503);

    await expect(fetchPackageMetadataFromRegistry('@scope/package')).resolves.toEqual({
      kind: 'transport-error',
      reason: 'http-status',
      statusCode: 503,
    });
  });

  it('sets a registry request timeout with package context', async () => {
    const request = createMockRequest();
    vi.mocked(https.get).mockImplementationOnce(() => {
      process.nextTick(() => request.emit('timeout'));
      return toClientRequest(request);
    });

    await expect(fetchPackageMetadataFromRegistry('react')).resolves.toEqual({
      kind: 'timeout',
      timeoutMs: 15000,
    });
    expect(request.setTimeout).toHaveBeenCalledWith(15000);
    expect(request.destroy).toHaveBeenCalledWith(expect.objectContaining({
      message: 'npm registry request timed out after 15000ms for react',
    }));
  });

  it('returns a response transport outcome when the response stream errors', async () => {
    const error = new Error('response stream reset');
    vi.mocked(https.get).mockImplementationOnce((_url, _options, callback) => {
      const response = new EventEmitter() as IncomingMessage;
      response.statusCode = 200;
      process.nextTick(() => {
        callback?.(response);
        response.emit('error', error);
      });
      return toClientRequest(createMockRequest());
    });

    await expect(fetchPackageMetadataFromRegistry('react')).resolves.toEqual({
      kind: 'transport-error',
      reason: 'response',
    });
  });

  it('returns a malformed outcome for invalid JSON', async () => {
    mockRegistryResponse('not valid json');

    await expect(fetchPackageMetadataFromRegistry('react')).resolves.toEqual({
      kind: 'malformed',
      reason: 'json',
    });
  });

  it('ignores a request error that arrives after the request already timed out', async () => {
    const request = createMockRequest();
    vi.mocked(https.get).mockImplementationOnce(() => {
      process.nextTick(() => {
        request.emit('timeout');
        request.emit('error', new Error('stray network error'));
      });
      return toClientRequest(request);
    });

    await expect(fetchPackageMetadataFromRegistry('react')).resolves.toEqual({
      kind: 'timeout',
      timeoutMs: 15000,
    });
  });

  it('returns overflow before unbounded buffering', async () => {
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

    await expect(fetchPackageMetadataFromRegistry('large-package')).resolves.toEqual({
      kind: 'overflow',
      maxBufferBytes: 5242880,
    });
    expect(request.destroy).toHaveBeenCalledWith(expect.objectContaining({
      message: 'npm registry response exceeded 5242880 bytes for large-package',
    }));
  });

  it('returns unavailable only when registry URL resolution throws', async () => {
    vi.mocked(vscode.workspace.getWorkspaceFolder).mockImplementationOnce(() => {
      throw new Error('workspace lookup failed');
    });

    await expect(fetchPackageMetadataFromRegistry('react', '/workspace/package.json')).resolves.toEqual({
      kind: 'unavailable',
      reason: 'configuration-unavailable',
    });
    expect(https.get).not.toHaveBeenCalled();
  });

  it('does not classify an invalid package name as unavailable', async () => {
    await expect(fetchPackageMetadataFromRegistry('\uD800')).rejects.toThrow(URIError);
    expect(https.get).not.toHaveBeenCalled();
  });

  it('parses publish times at the parser boundary', () => {
    expect(parseNpmRegistryMetadata({
      'dist-tags': { latest: '2.0.0' },
      versions: { '1.0.0': {}, '2.0.0': {} },
      time: {
        created: '2020-01-01T00:00:00.000Z',
        modified: '2024-01-01T00:00:00.000Z',
        '1.0.0': '2020-02-01T00:00:00.000Z',
      },
    })).toEqual({
      kind: 'recognized',
      result: {
        distTags: { latest: '2.0.0' },
        publishTimes: {
          kind: 'provided',
          byVersion: { '1.0.0': '2020-02-01T00:00:00.000Z' },
        },
        versions: ['2.0.0', '1.0.0'],
      },
    });
  });

  it('distinguishes a source without publish times from a version without a time', () => {
    expect(parseNpmRegistryMetadata({
      'dist-tags': {},
      versions: { '1.0.0': {} },
    })).toEqual({
      kind: 'recognized',
      result: {
        distTags: {},
        publishTimes: { kind: 'not-provided' },
        versions: ['1.0.0'],
      },
    });

    expect(parseNpmRegistryMetadata({
      'dist-tags': {},
      versions: { '1.0.0': {}, '2.0.0': {} },
      time: { '1.0.0': '2020-02-01T00:00:00.000Z' },
    })).toEqual({
      kind: 'recognized',
      result: {
        distTags: {},
        publishTimes: {
          kind: 'provided',
          byVersion: { '1.0.0': '2020-02-01T00:00:00.000Z' },
        },
        versions: ['2.0.0', '1.0.0'],
      },
    });
  });

  it('degrades malformed auxiliary publish-time fields without discarding metadata', () => {
    const base = {
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': {} },
    };

    expect(parseNpmRegistryMetadata({ ...base, time: null })).toMatchObject({
      kind: 'recognized',
      result: { publishTimes: { kind: 'not-provided' } },
    });
    expect(parseNpmRegistryMetadata({ ...base, time: { '1.0.0': 1700000000000 } })).toMatchObject({
      kind: 'recognized',
      result: { publishTimes: { kind: 'provided', byVersion: {} } },
    });
    expect(parseNpmRegistryMetadata({
      ...base,
      time: { '1.0.0': '2020-01-01T00:00:00.000Z', unpublished: { name: 'x' } },
    })).toMatchObject({
      kind: 'recognized',
      result: {
        publishTimes: {
          kind: 'provided',
          byVersion: { '1.0.0': '2020-01-01T00:00:00.000Z' },
        },
      },
    });
  });

  it('classifies unknown and malformed packument schemas', () => {
    expect(parseNpmRegistryMetadata({})).toEqual({ kind: 'unrecognized' });
    expect(parseNpmRegistryMetadata({ 'dist-tags': [], versions: {} })).toEqual({ kind: 'malformed' });
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