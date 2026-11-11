import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import * as https from 'node:https';
import type { IncomingMessage } from 'node:http';
import * as vscode from 'vscode';
import { setWorkspaceFolders } from './fixtures';
import { createMockRequest, mockNpmrcFiles, mockRegistryResponse, toClientRequest } from './fixtures/registryClientHarness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPackageMetadataFromRegistry } from '../utils/registryClient';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));
vi.mock('node:https', () => ({
  get: vi.fn(),
}));
vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/home/user'),
}));

const detectPackageManagerMock = vi.hoisted(() => vi.fn());
const resolveYarnFamilyMock = vi.hoisted(() => vi.fn());

vi.mock('../utils/packageManager', () => ({
  detectPackageManager: detectPackageManagerMock,
}));
vi.mock('../utils/yarnFamily', async () => {
  const { runWithYarnFamilyMemoPassthrough } = await import('./fixtures/yarnFamilyMemo');
  return {
    resolveYarnFamily: resolveYarnFamilyMock,
    runWithYarnFamilyMemo: runWithYarnFamilyMemoPassthrough,
  };
});

describe('fetchPackageMetadataFromRegistry()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NO_PROXY', '');
    vi.stubEnv('no_proxy', '');
    vi.mocked(readFile).mockRejectedValue(new Error('missing npmrc'));
    detectPackageManagerMock.mockResolvedValue('yarn');
    resolveYarnFamilyMock.mockResolvedValue({ family: 'unknown', source: 'version-probe' });
    setWorkspaceFolders([{ uri: { fsPath: '/workspace' } }]);
    vi.mocked(vscode.workspace.getWorkspaceFolder).mockImplementation((uri: { fsPath: string }) => {
      return vscode.workspace.workspaceFolders?.find(folder => uri.fsPath.startsWith(`${folder.uri.fsPath}/`));
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('never applies HTTPS auth configuration to an HTTP registry', async () => {
    mockNpmrcFiles({
      '/workspace/.npmrc': [
        'registry=http://registry.example.com',
        '//registry.example.com/:_authToken=plaintext-token',
      ].join('\n'),
    });

    await expect(fetchPackageMetadataFromRegistry('react', '/workspace/package.json')).resolves.toEqual({
      kind: 'unavailable',
      reason: 'configuration-unavailable',
      privateRegistry: true,
    });
    expect(https.get).not.toHaveBeenCalled();
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

  it('ignores malformed npm auth keys and package scopes without a package name', async () => {
    mockNpmrcFiles({
      '/workspace/.npmrc': [
        'not-an-assignment',
        '//:_authToken=invalid',
        '//registry.example.com/:unsupported=value',
        '//[invalid/:_authToken=value',
        '//user:password@registry.example.com/:_authToken=value',
      ].join('\n'),
    });
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));

    await fetchPackageMetadataFromRegistry('@scope', '/workspace/package.json');
    await fetchPackageMetadataFromRegistry('react', '/workspace/package.json');

    expect(vi.mocked(https.get)).toHaveBeenCalledTimes(2);
  });
});