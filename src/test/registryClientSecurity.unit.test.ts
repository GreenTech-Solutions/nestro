import { readFile } from 'node:fs/promises';
import * as https from 'node:https';
import * as vscode from 'vscode';
import { setWorkspaceFolders } from './fixtures';
import { expectRegistryUrl, expectRequestHeaders, mockNpmrcFiles, mockRegistryResponse } from './fixtures/registryClientHarness';
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

  it('passes Modern Yarn proxy, CA file, and strict SSL settings', async () => {
    resolveYarnFamilyMock.mockResolvedValueOnce({ family: 'modern', source: 'project-markers' });
    vi.stubEnv('NO_PROXY', 'registry.example.com');
    mockNpmrcFiles({
      '/workspace/.yarnrc.yml': [
        'npmRegistryServer: https://registry.example.com',
        'httpsProxy: https://proxy.example.com',
        'caFilePath: ./company-ca.pem',
        'enableStrictSsl: false',
      ].join('\n'),
      '/workspace/company-ca.pem': 'company-ca',
    });
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));

    await fetchPackageMetadataFromRegistry('react', '/workspace/package.json', undefined, 'yarn');

    expect(vi.mocked(https.get).mock.calls[0][1]).toMatchObject({
      ca: 'company-ca',
      rejectUnauthorized: false,
    });
  });

  it('drops Modern Yarn credentials on a cross-origin redirect', async () => {
    resolveYarnFamilyMock.mockResolvedValueOnce({ family: 'modern', source: 'project-markers' });
    mockNpmrcFiles({
      '/workspace/.yarnrc.yml': [
        'npmRegistryServer: https://private.example.com/npm/',
        'npmAuthToken: private-token',
      ].join('\n'),
    });
    mockRegistryResponse('', 302, 'https://public.example.com/npm/react');
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));

    await expect(fetchPackageMetadataFromRegistry(
      'react',
      '/workspace/package.json',
      undefined,
      'yarn',
    )).resolves.toMatchObject({ kind: 'success' });
    expect(vi.mocked(https.get).mock.calls[1][1]).not.toMatchObject({
      headers: { Authorization: 'Bearer private-token' },
    });
  });

  it('fails closed for an ambiguous Yarn family instead of using a Yarn config', async () => {
    resolveYarnFamilyMock.mockResolvedValueOnce({ family: 'unknown', source: 'conflicting-markers' });
    mockNpmrcFiles({
      '/workspace/.yarnrc.yml': 'npmRegistryServer: https://private.example.com',
      '/workspace/.yarnrc': 'registry "https://classic.example.com"',
    });

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

  it('prefers the nearest nested project .npmrc over its workspace root and user files', async () => {
    mockNpmrcFiles({
      '/home/user/.npmrc': 'registry=https://user-registry.example.com',
      '/workspace/.npmrc': 'registry=https://root-registry.example.com\nproxy=https://root-proxy.example.com',
      '/workspace/packages/app/.npmrc': 'registry=https://nested-registry.example.com\nproxy=',
    });
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));

    await fetchPackageMetadataFromRegistry('react', '/workspace/packages/app/package.json');

    expectRegistryUrl('https://nested-registry.example.com/react');
  });

  it('applies npm_config values and substitutes environment variables after file resolution', async () => {
    vi.stubEnv('NPM_TOKEN', 'env-secret-token');
    vi.stubEnv('npm_config_registry', 'https://env-registry.example.com/npm/');
    mockNpmrcFiles({
      '/workspace/.npmrc': [
        'registry=https://file-registry.example.com',
        '//env-registry.example.com/npm/:_authToken=${NPM_TOKEN}',
      ].join('\n'),
    });
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));

    await fetchPackageMetadataFromRegistry('react', '/workspace/package.json');

    expectRegistryUrl('https://env-registry.example.com/npm/react');
    expectRequestHeaders({ Authorization: 'Bearer env-secret-token' });
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

  it('sends the most-specific path-scoped token and never sends an unscoped token', async () => {
    mockNpmrcFiles({
      '/workspace/.npmrc': [
        'registry=https://registry.example.com/npm/private/',
        '//registry.example.com/:_authToken=host-token',
        '//registry.example.com/npm/private/:_authToken=private-token',
        '_authToken=unscoped-token',
      ].join('\n'),
    });
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));

    await fetchPackageMetadataFromRegistry('private', '/workspace/package.json');

    expectRequestHeaders({ Authorization: 'Bearer private-token' });
    expect(vi.mocked(https.get).mock.calls[0][1]).not.toMatchObject({
      headers: { Authorization: 'Bearer unscoped-token' },
    });
  });

  it('supports base64 auth and username plus base64 password credentials', async () => {
    mockNpmrcFiles({
      '/workspace/.npmrc': [
        'registry=https://registry.example.com',
        '//registry.example.com/:_auth=dXNlcjpwYXNz',
      ].join('\n'),
    });
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));
    await fetchPackageMetadataFromRegistry('first', '/workspace/package.json');
    expectRequestHeaders({ Authorization: 'Basic dXNlcjpwYXNz' });

    mockNpmrcFiles({
      '/workspace/.npmrc': [
        'registry=https://registry.example.com',
        '//registry.example.com/:username=alice',
        '//registry.example.com/:_password=c2VjcmV0',
      ].join('\n'),
    });
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));
    await fetchPackageMetadataFromRegistry('second', '/workspace/package.json');
    expect(vi.mocked(https.get).mock.calls[1][1]).toMatchObject({
      headers: { Authorization: 'Basic YWxpY2U6c2VjcmV0' },
    });
  });

  it('passes configured CA and strict-ssl to the HTTPS request', async () => {
    mockNpmrcFiles({
      '/workspace/.npmrc': [
        'registry=https://registry.example.com',
        'ca="-----BEGIN CERTIFICATE-----\\ncert\\n-----END CERTIFICATE-----"',
        'strict-ssl=false',
      ].join('\n'),
    });
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));

    await fetchPackageMetadataFromRegistry('react', '/workspace/package.json');

    expect(vi.mocked(https.get).mock.calls[0][1]).toMatchObject({
      ca: '-----BEGIN CERTIFICATE-----\ncert\n-----END CERTIFICATE-----',
      rejectUnauthorized: false,
    });
  });

  it('passes strict-ssl=true and ignores an unrecognised boolean value', async () => {
    mockNpmrcFiles({ '/workspace/.npmrc': 'registry=https://registry.example.com\nstrict-ssl=true' });
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));
    await fetchPackageMetadataFromRegistry('first', '/workspace/package.json');
    expect(vi.mocked(https.get).mock.calls[0][1]).toMatchObject({ rejectUnauthorized: true });

    mockNpmrcFiles({ '/workspace/.npmrc': 'registry=https://registry.example.com\nstrict-ssl=maybe' });
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));
    await fetchPackageMetadataFromRegistry('second', '/workspace/package.json');
    expect(vi.mocked(https.get).mock.calls[1][1]).not.toHaveProperty('rejectUnauthorized');
  });

  it.each([
    ['an exact', 'https://registry.example.com', 'registry.example.com', 'https://registry.example.com/react'],
    ['a dot-suffix', 'https://packages.internal.example.com/npm/', '.internal.example.com', 'https://packages.internal.example.com/npm/react'],
    ['a wildcard', 'https://registry.example.com', '*', 'https://registry.example.com/react'],
  ] as const)('connects directly for %s no-proxy entry', async (_label, registry, noProxy, expectedUrl) => {
    mockNpmrcFiles({
      '/workspace/.npmrc': [
        `registry=${registry}`,
        'proxy=https://proxy.example.com',
        `no-proxy=${noProxy}`,
      ].join('\n'),
    });
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));

    await expect(fetchPackageMetadataFromRegistry('react', '/workspace/package.json')).resolves.toMatchObject({
      kind: 'success',
    });
    expectRegistryUrl(expectedUrl);
  });

  it('refuses a non-exempt registry host when a proxy is configured', async () => {
    mockNpmrcFiles({
      '/workspace/.npmrc': [
        'registry=https://registry.example.com',
        'proxy=https://proxy.example.com',
        'no-proxy=.internal.example.com',
      ].join('\n'),
    });

    await expect(fetchPackageMetadataFromRegistry('react', '/workspace/package.json')).resolves.toEqual({
      kind: 'transport-error',
      reason: 'proxy-unsupported',
      privateRegistry: true,
    });
    expect(https.get).not.toHaveBeenCalled();
  });

  it('honors the uppercase NO_PROXY environment form', async () => {
    vi.stubEnv('NO_PROXY', 'registry.example.com');
    mockNpmrcFiles({
      '/workspace/.npmrc': [
        'registry=https://registry.example.com',
        'proxy=https://proxy.example.com',
      ].join('\n'),
    });
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));

    await expect(fetchPackageMetadataFromRegistry('react', '/workspace/package.json')).resolves.toMatchObject({
      kind: 'success',
    });
    expectRegistryUrl('https://registry.example.com/react');
  });

  it('honors the lowercase no_proxy environment form', async () => {
    vi.stubEnv('no_proxy', 'registry.example.com');
    mockNpmrcFiles({
      '/workspace/.npmrc': [
        'registry=https://registry.example.com',
        'proxy=https://proxy.example.com',
      ].join('\n'),
    });
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));

    await expect(fetchPackageMetadataFromRegistry('react', '/workspace/package.json')).resolves.toMatchObject({
      kind: 'success',
    });
    expectRegistryUrl('https://registry.example.com/react');
  });

  it('loads a configured cafile and refuses to connect directly through a configured proxy', async () => {
    mockNpmrcFiles({
      '/workspace/.npmrc': [
        'registry=https://registry.example.com',
        'cafile=/workspace/company-ca.pem',
        'https-proxy=https://proxy.example.com',
      ].join('\n'),
      '/workspace/company-ca.pem': 'company-ca',
    });

    await expect(fetchPackageMetadataFromRegistry('react', '/workspace/package.json')).resolves.toEqual({
      kind: 'transport-error',
      reason: 'proxy-unsupported',
      privateRegistry: true,
    });
    expect(https.get).not.toHaveBeenCalled();
  });

  it('uses the owning workspace .npmrc in a multi-root workspace', async () => {
    setWorkspaceFolders([
      { uri: { fsPath: '/workspace/app-one' } },
      { uri: { fsPath: '/workspace/app-two' } },
    ]);
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
    setWorkspaceFolders([
      { uri: { fsPath: '/workspace/public-app' } },
      { uri: { fsPath: '/workspace/private-app' } },
    ]);
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
});