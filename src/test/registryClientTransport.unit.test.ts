import { readFile } from 'node:fs/promises';
import * as https from 'node:https';
import * as vscode from 'vscode';
import { setWorkspaceFolders } from './fixtures';
import { createMockRequest, expectRegistryUrl, mockNpmrcFiles, mockRegistryResponse, toClientRequest } from './fixtures/registryClientHarness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configAwareHttpsMetadataAdapter, MetadataAdapterRegistry } from '../utils/metadataRegistry';
import type { MetadataAdapter } from '../utils/metadataRegistry';
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

const resolveYarnFamilyMock = vi.hoisted(() => vi.fn());

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
    resolveYarnFamilyMock.mockResolvedValue({ family: 'unknown', source: 'version-probe' });
    setWorkspaceFolders([{ uri: { fsPath: '/workspace' } }]);
    vi.mocked(vscode.workspace.getWorkspaceFolder).mockImplementation((uri: { fsPath: string }) => {
      return vscode.workspace.workspaceFolders?.find(folder => uri.fsPath.startsWith(`${folder.uri.fsPath}/`));
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns a transport outcome for network errors', async () => {
    const request = createMockRequest();
    vi.mocked(https.get).mockImplementationOnce(() => {
      process.nextTick(() => request.emit('error', new Error('network down npm_1234567890abcdef')));
      return toClientRequest(request);
    });

    const outcome = await fetchPackageMetadataFromRegistry('react');
    expect(outcome).toEqual({
      kind: 'transport-error',
      reason: 'request',
    });
    expect(JSON.stringify(outcome)).not.toContain('npm_1234567890abcdef');
  });

  it('follows same-origin redirects with credentials intact', async () => {
    mockNpmrcFiles({
      '/workspace/.npmrc': [
        'registry=https://registry.example.com/npm/',
        '//registry.example.com/npm/:_authToken=private-token',
      ].join('\n'),
    });
    mockRegistryResponse('', 302, '/npm/v2/react');
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));

    await expect(fetchPackageMetadataFromRegistry('react', '/workspace/package.json')).resolves.toMatchObject({
      kind: 'success',
    });
    expect(vi.mocked(https.get).mock.calls[1][0]).toBe('https://registry.example.com/npm/v2/react');
    expect(vi.mocked(https.get).mock.calls[1][1]).toMatchObject({
      headers: { Authorization: 'Bearer private-token' },
    });
  });

  it('drops credentials before following a cross-origin redirect', async () => {
    mockNpmrcFiles({
      '/workspace/.npmrc': [
        'registry=https://private.example.com/npm/',
        '//private.example.com/npm/:_authToken=private-token',
      ].join('\n'),
    });
    mockRegistryResponse('', 302, 'https://public.example.com/npm/react');
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));

    await expect(fetchPackageMetadataFromRegistry('react', '/workspace/package.json')).resolves.toMatchObject({
      kind: 'success',
    });
    expect(vi.mocked(https.get).mock.calls[1][1]).toMatchObject({
      headers: { Accept: 'application/vnd.npm.install-v1+json' },
    });
    expect(vi.mocked(https.get).mock.calls[1][1]).not.toMatchObject({
      headers: { Authorization: 'Bearer private-token' },
    });
  });

  it('fails closed for invalid redirect targets and excessive redirect chains', async () => {
    mockNpmrcFiles({ '/workspace/.npmrc': 'registry=https://registry.example.com' });
    mockRegistryResponse('', 302, 'http://registry.example.com/react');
    await expect(fetchPackageMetadataFromRegistry('invalid-protocol', '/workspace/package.json')).resolves.toEqual({
      kind: 'transport-error',
      reason: 'request',
      privateRegistry: true,
    });

    mockNpmrcFiles({ '/workspace/.npmrc': 'registry=https://registry.example.com' });
    mockRegistryResponse('', 302, 'https://[invalid');
    await expect(fetchPackageMetadataFromRegistry('invalid-url', '/workspace/package.json')).resolves.toEqual({
      kind: 'transport-error',
      reason: 'request',
      privateRegistry: true,
    });

    vi.mocked(https.get).mockClear();
    mockNpmrcFiles({ '/workspace/.npmrc': 'registry=https://registry.example.com' });
    mockRegistryResponse('', 302, '/one');
    mockRegistryResponse('', 302, '/two');
    mockRegistryResponse('', 302, '/three');
    mockRegistryResponse('', 302, '/four');
    await expect(fetchPackageMetadataFromRegistry('too-many', '/workspace/package.json')).resolves.toEqual({
      kind: 'transport-error',
      reason: 'request',
      privateRegistry: true,
    });
    expect(vi.mocked(https.get).mock.calls).toHaveLength(4);
  });

  it('does not retry a scoped private registry against public npm', async () => {
    mockNpmrcFiles({
      '/workspace/.npmrc': [
        'registry=https://registry.npmjs.org',
        '@private:registry=https://private.example.com/npm/',
      ].join('\n'),
    });
    mockRegistryResponse(JSON.stringify({ error: 'Not found' }), 404);

    await expect(fetchPackageMetadataFromRegistry('@private/pkg', '/workspace/package.json')).resolves.toEqual({
      kind: 'transport-error',
      reason: 'http-status',
      statusCode: 404,
      privateRegistry: true,
    });
    expect(vi.mocked(https.get).mock.calls).toHaveLength(1);
    expectRegistryUrl('https://private.example.com/npm/@private%2Fpkg');
  });

  it('does not retry an unreachable Modern Yarn private scope against public npm', async () => {
    resolveYarnFamilyMock.mockResolvedValueOnce({ family: 'modern', source: 'project-markers' });
    mockNpmrcFiles({
      '/workspace/.yarnrc.yml': [
        'npmScopes:',
        '  private:',
        '    npmRegistryServer: https://private.example.com/npm/',
        '    npmAuthToken: private-token',
      ].join('\n'),
    });
    vi.mocked(https.get).mockImplementationOnce(() => {
      const request = createMockRequest();
      process.nextTick(() => request.emit('error', new Error('private registry unavailable')));
      return toClientRequest(request);
    });
    const publicAdapter: MetadataAdapter = {
      tier: 'config-aware-https',
      packageManagers: ['yarn'],
      fetchMetadata: vi.fn().mockResolvedValue({
        kind: 'success',
        result: { distTags: {}, publishTimes: { kind: 'not-provided' }, versions: ['9.9.9'] },
      }),
    };

    await expect(new MetadataAdapterRegistry(() => Promise.resolve('yarn'), [
      configAwareHttpsMetadataAdapter,
      publicAdapter,
    ]).fetchMetadata({
      packageName: '@private/pkg',
      packageFilePath: '/workspace/package.json',
    })).resolves.toEqual({ kind: 'transport-error', reason: 'request', privateRegistry: true });
    expect(publicAdapter.fetchMetadata).not.toHaveBeenCalled();
  });

  it('returns unavailable for an invalid configured registry instead of connecting elsewhere', async () => {
    mockNpmrcFiles({ '/workspace/.npmrc': 'registry=http://registry.example.com' });

    await expect(fetchPackageMetadataFromRegistry('react', '/workspace/package.json')).resolves.toEqual({
      kind: 'unavailable',
      reason: 'configuration-unavailable',
      privateRegistry: true,
    });
    expect(https.get).not.toHaveBeenCalled();
  });
});