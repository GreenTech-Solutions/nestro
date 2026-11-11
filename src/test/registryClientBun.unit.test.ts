import { readFile } from 'node:fs/promises';
import * as https from 'node:https';
import * as vscode from 'vscode';
import { setWorkspaceFolders } from './fixtures';
import { createMockRequest, expectRegistryUrl, expectRequestHeaders, mockNpmrcFiles, mockRegistryResponse, toClientRequest } from './fixtures/registryClientHarness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configAwareHttpsMetadataAdapter, MetadataAdapterRegistry, parseBunConfig } from '../utils';
import type { MetadataAdapter } from '../utils';
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

  it('uses the Bun project registry through HTTPS without requiring the Bun CLI', async () => {
    mockNpmrcFiles({
      '/workspace/bunfig.toml': [
        '[install]',
        'registry = "https://bun.example.com/npm/"',
      ].join('\n'),
    });
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));

    await expect(fetchPackageMetadataFromRegistry(
      'react',
      '/workspace/package.json',
      undefined,
      'bun',
    )).resolves.toMatchObject({ kind: 'success' });
    expectRegistryUrl('https://bun.example.com/npm/react');
  });

  it('uses public npm when no Bun config is found', async () => {
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));

    await expect(fetchPackageMetadataFromRegistry(
      'react',
      '/workspace/package.json',
      undefined,
      'bun',
    )).resolves.toEqual({
      kind: 'success',
      result: {
        distTags: {},
        publishTimes: { kind: 'not-provided' },
        versions: ['1.0.0'],
      },
    });
    expectRegistryUrl('https://registry.npmjs.org/react');
  });

  it('uses Bun token credentials from an install registry table', async () => {
    mockNpmrcFiles({
      '/workspace/bunfig.toml': [
        '[install]',
        'registry = { url = "https://bun.example.com/npm/", token = "bun-token" }',
      ].join('\n'),
    });
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));

    await fetchPackageMetadataFromRegistry('react', '/workspace/package.json', undefined, 'bun');

    expectRegistryUrl('https://bun.example.com/npm/react');
    expectRequestHeaders({ Authorization: 'Bearer bun-token' });
  });

  it('uses credentials embedded in a Bun registry URL without exposing URL userinfo', async () => {
    mockNpmrcFiles({
      '/workspace/bunfig.toml': [
        '[install]',
        'registry = "https://alice:secret@bun.example.com/npm/"',
      ].join('\n'),
    });
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));

    await fetchPackageMetadataFromRegistry('react', '/workspace/package.json', undefined, 'bun');

    expectRegistryUrl('https://bun.example.com/npm/react');
    expectRequestHeaders({ Authorization: 'Basic YWxpY2U6c2VjcmV0' });
    expect(JSON.stringify(vi.mocked(https.get).mock.calls[0])).not.toContain('alice:secret');
  });

  it('resolves Bun config from the home directory and nearer project ancestors', async () => {
    mockNpmrcFiles({
      '/home/user/bunfig.toml': '[install.scopes]\n"@acme" = "https://home-acme.example.com/npm/"',
      '/workspace/bunfig.toml': [
        '[install.scopes]',
        '"@acme" = "https://workspace-acme.example.com/npm/"',
      ].join('\n'),
      '/workspace/packages/app/bunfig.toml': '[install.scopes]\n"@acme" = "https://nested-acme.example.com/npm/"',
    });
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));

    await fetchPackageMetadataFromRegistry(
      '@acme/pkg',
      '/workspace/packages/app/package.json',
      undefined,
      'bun',
    );

    expectRegistryUrl('https://nested-acme.example.com/npm/@acme%2Fpkg');
  });

  it('does not bind a top-level Bun token to a scoped registry on another host', async () => {
    mockNpmrcFiles({
      '/workspace/bunfig.toml': [
        '[install]',
        'registry = { url = "https://top.example.com/npm/", token = "top-token" }',
        '[install.scopes]',
        '"@acme" = "https://scope.example.com/npm/"',
      ].join('\n'),
    });
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));

    await fetchPackageMetadataFromRegistry('@acme/pkg', '/workspace/package.json', undefined, 'bun');

    expectRegistryUrl('https://scope.example.com/npm/@acme%2Fpkg');
    expect(vi.mocked(https.get).mock.calls[0][1]).not.toMatchObject({
      headers: { Authorization: 'Bearer top-token' },
    });
  });

  it('keeps an npmrc scoped registry ahead of the Bun global registry', async () => {
    mockNpmrcFiles({
      '/workspace/.npmrc': '@acme:registry=https://npmrc-scope.example.com/npm/',
      '/workspace/bunfig.toml': [
        '[install]',
        'registry = "https://bun-global.example.com/npm/"',
      ].join('\n'),
    });
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));

    await fetchPackageMetadataFromRegistry('@acme/pkg', '/workspace/package.json', undefined, 'bun');

    expectRegistryUrl('https://npmrc-scope.example.com/npm/@acme%2Fpkg');
  });

  it('uses all supported Bun scope entry shapes and expands both environment forms', () => {
    vi.stubEnv('BUN_PASSWORD', 'secret');
    vi.stubEnv('BUN_TOKEN', 'token');

    expect(parseBunConfig([
      '[install.scopes]',
      '"@plain" = "https://alice:secret@plain.example.com/"',
      '"@basic" = { username = "alice", password = "$BUN_PASSWORD", url = "https://basic.example.com/" }',
      '"@token" = { token = "${BUN_TOKEN}", url = "https://token.example.com/" }',
    ].join('\n'))).toEqual({
      registry: undefined,
      scopes: new Map([
        ['plain', { registryUrl: 'https://plain.example.com/', authToken: undefined, authIdent: 'alice:secret' }],
        ['basic', { registryUrl: 'https://basic.example.com/', authToken: undefined, authIdent: 'alice:secret' }],
        ['token', { registryUrl: 'https://token.example.com/', authToken: 'token', authIdent: undefined }],
      ]),
    });
  });

  it('ignores unrelated Bun configuration while resolving metadata', async () => {
    const configurations = [
      {
        contents: '[test]\npreload = ["./happydom.ts"]',
        expectedUrl: 'https://registry.npmjs.org/react',
      },
      {
        contents: '[install]\nregistry = "https://bun.example.com/npm/"\nexact = true',
        expectedUrl: 'https://bun.example.com/npm/react',
      },
      {
        contents: 'telemetry = false',
        expectedUrl: 'https://registry.npmjs.org/react',
      },
      {
        contents: '[install]\nregistry = "https://bun.example.com/npm/"\n[install.cache]\ndir = ".bun-cache"',
        expectedUrl: 'https://bun.example.com/npm/react',
      },
      {
        contents: 'preload = ["./happydom.ts"]\n[install]\nregistry = "https://bun.example.com/npm/"',
        expectedUrl: 'https://bun.example.com/npm/react',
      },
    ];

    for (const configuration of configurations) {
      mockNpmrcFiles({ '/workspace/bunfig.toml': configuration.contents });
      mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));

      await expect(fetchPackageMetadataFromRegistry('react', '/workspace/package.json', undefined, 'bun'))
        .resolves.toMatchObject({ kind: 'success' });
      const calls = vi.mocked(https.get).mock.calls;
      expect(calls[calls.length - 1]?.[0]).toBe(configuration.expectedUrl);
    }
  });

  it('rejects unresolved variables and malformed Bun registry shapes', () => {
    delete process.env.NESTRO_BUN_UNSET;
    expect(parseBunConfig('[install]\nregistry = "$NESTRO_BUN_UNSET"')).toBeUndefined();
    expect(parseBunConfig('\uFEFF[install]\nregistry = "https://registry.example.com"')).toBeUndefined();
    expect(parseBunConfig('[install]\nregistry = https://registry.example.com')).toBeUndefined();
    expect(parseBunConfig('[install]\nregistry = { url = "https://registry.example.com", token = "x", username = "a", password = "b" }')).toBeUndefined();
    expect(parseBunConfig('[install]\nregistry = ["https://registry.example.com"]')).toBeUndefined();
    expect(parseBunConfig('[install]\nregistry.foo = "https://registry.example.com"')).toBeUndefined();
    expect(parseBunConfig('[[install]]\nregistry = "https://registry.example.com"')).toBeUndefined();
    expect(parseBunConfig('registry = "https://registry.example.com"')).toEqual({
      registry: undefined,
      scopes: new Map(),
    });
    expect(parseBunConfig('[install]\nregistry')).toBeUndefined();
    expect(parseBunConfig('[install]\nregistry =')).toBeUndefined();
    expect(parseBunConfig('[install]\nregistry = {}')).toBeUndefined();
    expect(parseBunConfig('[install]\nregistry = { url = "https://registry.example.com/" }')).toBeUndefined();
    expect(parseBunConfig('[install]\nregistry = { url = "https://registry.example.com/", username = "alice" }')).toBeUndefined();
    expect(parseBunConfig('[install]\nregistry = { url = "https://registry.example.com/", unknown = "value" }')).toBeUndefined();
    expect(parseBunConfig('[install]\nregistry = { url "https://registry.example.com/" }')).toBeUndefined();
    expect(parseBunConfig('[install]\nregistry = { url = ["https://registry.example.com/"] }')).toBeUndefined();
    expect(parseBunConfig('[install]\nregistry = { url = "https://registry.example.com/" token = "value" }')).toBeUndefined();
    expect(parseBunConfig('[install]\nregistry = { url = "https://registry.example.com/", }')).toBeUndefined();
    expect(parseBunConfig('[install]\nregistry = { url = "https://registry.example.com/", token = "bad\\q" }')).toBeUndefined();
    expect(parseBunConfig('[install]\nregistry = "unterminated')).toBeUndefined();
    expect(parseBunConfig('[install]\nregistry = "not-a-url"')).toBeUndefined();
    expect(parseBunConfig('[install]\nregistry = "https://alice@example.com"')).toBeUndefined();
    expect(parseBunConfig('[install]\nregistry = "https://alice:%ZZ@example.com"')).toBeUndefined();
    expect(parseBunConfig('[install]\nregistry = { url = "https://alice:secret@example.com", token = "value" }')).toBeUndefined();
    expect(parseBunConfig('[install]\nregistry = { url = "https://alice:secret@example.com", username = "bob", password = "value" }')).toBeUndefined();
    expect(parseBunConfig('[install]\nregistry = "https://registry.example.com"\n[install]')).toBeUndefined();
    expect(parseBunConfig('[install.scopes]\n"@acme"tail = "https://registry.example.com"')).toBeUndefined();
    expect(parseBunConfig([
      '[install.scopes]',
      '"@acme" = "https://first.example.com"',
      '"@acme" = "https://second.example.com"',
    ].join('\n'))).toBeUndefined();
  });

  it('keeps TOML comments and supported string escapes inside Bun values', () => {
    expect(parseBunConfig([
      '[install]',
      'registry = { url = "https://registry.example.com/", token = "token\\\"value" } # comment',
    ].join('\n'))).toEqual({
      registry: {
        registryUrl: 'https://registry.example.com/',
        authToken: 'token"value',
        authIdent: undefined,
      },
      scopes: new Map(),
    });
  });

  it('fails closed for malformed Bun config and keeps a private scope out of public fallback', async () => {
    mockNpmrcFiles({
      '/workspace/bunfig.toml': [
        '[install.scopes]',
        '"@acme" = { url = "https://private.example.com/npm/", token = "secret"',
      ].join('\n'),
    });

    await expect(fetchPackageMetadataFromRegistry(
      '@acme/pkg',
      '/workspace/package.json',
      undefined,
      'bun',
    )).resolves.toEqual({
      kind: 'unavailable',
      reason: 'configuration-unavailable',
      privateRegistry: true,
      message: 'Malformed bunfig.toml at /workspace/bunfig.toml.',
    });
    expect(https.get).not.toHaveBeenCalled();
  });

  it('does not retry an unreachable Bun private scope against public npm', async () => {
    detectPackageManagerMock.mockResolvedValueOnce('bun');
    mockNpmrcFiles({
      '/workspace/bunfig.toml': [
        '[install.scopes]',
        '"@acme" = { url = "https://private.example.com/npm/", token = "private-token" }',
      ].join('\n'),
    });
    vi.mocked(https.get).mockImplementationOnce(() => {
      const request = createMockRequest();
      process.nextTick(() => request.emit('error', new Error('private registry unavailable')));
      return toClientRequest(request);
    });
    const publicAdapter: MetadataAdapter = {
      tier: 'config-aware-https',
      packageManagers: ['bun'],
      fetchMetadata: vi.fn().mockResolvedValue({
        kind: 'success',
        result: { distTags: {}, publishTimes: { kind: 'not-provided' }, versions: ['9.9.9'] },
      }),
    };

    await expect(new MetadataAdapterRegistry([
      configAwareHttpsMetadataAdapter,
      publicAdapter,
    ]).fetchMetadata({
      packageName: '@acme/pkg',
      packageFilePath: '/workspace/package.json',
    })).resolves.toEqual({ kind: 'transport-error', reason: 'request', privateRegistry: true });
    expect(publicAdapter.fetchMetadata).not.toHaveBeenCalled();
  });

  it('maps Bun registry timeout and removes its token on a cross-origin redirect', async () => {
    mockNpmrcFiles({
      '/workspace/bunfig.toml': [
        '[install]',
        'registry = { url = "https://private.example.com/npm/", token = "private-token" }',
      ].join('\n'),
    });
    const request = createMockRequest();
    vi.mocked(https.get).mockImplementationOnce(() => {
      process.nextTick(() => request.emit('timeout'));
      return toClientRequest(request);
    });

    await expect(fetchPackageMetadataFromRegistry('react', '/workspace/package.json', undefined, 'bun')).resolves.toEqual({
      kind: 'timeout',
      timeoutMs: 15000,
      privateRegistry: true,
    });

    mockRegistryResponse('', 302, 'https://public.example.com/npm/react');
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));
    await expect(fetchPackageMetadataFromRegistry('react', '/workspace/package.json', undefined, 'bun')).resolves.toMatchObject({
      kind: 'success',
    });
    expect(vi.mocked(https.get).mock.calls[2][1]).not.toMatchObject({
      headers: { Authorization: 'Bearer private-token' },
    });
  });

  it('marks a scoped npmrc configuration failure as private and does not retry publicly', async () => {
    mockNpmrcFiles({ '/workspace/.npmrc': '@private:registry=http://registry.example.com' });

    await expect(fetchPackageMetadataFromRegistry('@private/pkg', '/workspace/package.json')).resolves.toEqual({
      kind: 'unavailable',
      reason: 'configuration-unavailable',
      privateRegistry: true,
    });
    expect(https.get).not.toHaveBeenCalled();
  });

  it('marks a malformed Classic Yarn config as private without using public npm', async () => {
    resolveYarnFamilyMock.mockResolvedValueOnce({ family: 'classic', source: 'project-markers' });
    mockNpmrcFiles({ '/workspace/.yarnrc': 'registry "unterminated' });

    await expect(fetchPackageMetadataFromRegistry(
      '@private/pkg',
      '/workspace/package.json',
      undefined,
      'yarn',
    )).resolves.toEqual({
      kind: 'unavailable',
      reason: 'configuration-unavailable',
      privateRegistry: true,
    });
    expect(https.get).not.toHaveBeenCalled();
  });

  it('marks a malformed Modern Yarn config as private without using public npm', async () => {
    resolveYarnFamilyMock.mockResolvedValueOnce({ family: 'modern', source: 'project-markers' });
    mockNpmrcFiles({ '/workspace/.yarnrc.yml': 'npmRegistryServer: [' });

    await expect(fetchPackageMetadataFromRegistry(
      '@private/pkg',
      '/workspace/package.json',
      undefined,
      'yarn',
    )).resolves.toEqual({
      kind: 'unavailable',
      reason: 'configuration-unavailable',
      privateRegistry: true,
    });
    expect(https.get).not.toHaveBeenCalled();
  });
});