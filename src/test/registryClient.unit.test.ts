import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import * as https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchPackageMetadataFromRegistry,
  parseClassicYarnConfig,
  parseNpmRegistryMetadata,
  parseYarnModernConfig,
  selectVersionsForPicker,
} from '../utils/registryClient';
import { configAwareHttpsMetadataAdapter, MetadataAdapterRegistry, parseBunConfig } from '../utils';
import type { MetadataAdapter } from '../utils';

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
vi.mock('../utils/yarnFamily', () => ({
  resolveYarnFamily: resolveYarnFamilyMock,
}));

interface MockClientRequest extends EventEmitter {
  destroy: ReturnType<typeof vi.fn>;
  setTimeout: ReturnType<typeof vi.fn>;
}

describe('fetchPackageMetadataFromRegistry()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NO_PROXY', '');
    vi.stubEnv('no_proxy', '');
    vi.mocked(readFile).mockRejectedValue(new Error('missing npmrc'));
    detectPackageManagerMock.mockResolvedValue('yarn');
    resolveYarnFamilyMock.mockResolvedValue({ family: 'unknown', source: 'version-probe' });
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      configurable: true,
      value: [{ uri: { fsPath: '/workspace' } }],
    });
    vi.mocked(vscode.workspace.getWorkspaceFolder).mockImplementation((uri: { fsPath: string }) => {
      return vscode.workspace.workspaceFolders?.find(folder => uri.fsPath.startsWith(`${folder.uri.fsPath}/`));
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it('uses the Classic Yarn registry from the project .yarnrc format', async () => {
    resolveYarnFamilyMock.mockResolvedValueOnce({ family: 'classic', source: 'project-markers' });
    mockNpmrcFiles({
      '/workspace/.yarnrc': 'registry "https://classic.example.com/npm/"',
    });
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));

    await fetchPackageMetadataFromRegistry('react', '/workspace/package.json', undefined, 'yarn');

    expectRegistryUrl('https://classic.example.com/npm/react');
  });

  it('uses the Modern Yarn registry and token from .yarnrc.yml', async () => {
    resolveYarnFamilyMock.mockResolvedValueOnce({ family: 'modern', source: 'package-manager' });
    vi.stubEnv('YARN_TOKEN', 'modern-secret-token');
    mockNpmrcFiles({
      '/workspace/.yarnrc.yml': [
        'npmRegistryServer: "https://modern.example.com/npm/"',
        'npmAuthToken: ${YARN_TOKEN}',
      ].join('\n'),
    });
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));

    await fetchPackageMetadataFromRegistry('react', '/workspace/package.json', undefined, 'yarn');

    expectRegistryUrl('https://modern.example.com/npm/react');
    expectRequestHeaders({ Authorization: 'Bearer modern-secret-token' });
  });

  it('reads an ancestor Modern Yarn config when family resolution is unknown', async () => {
    mockNpmrcFiles({
      '/workspace/.yarnrc.yml': [
        'npmScopes:',
        '  acme:',
        '    npmRegistryServer: https://internal.acme.test/npm/',
      ].join('\n'),
    });
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));

    await fetchPackageMetadataFromRegistry(
      '@acme/secret-app',
      '/workspace/packages/app/package.json',
      undefined,
      'yarn',
    );

    expectRegistryUrl('https://internal.acme.test/npm/@acme%2Fsecret-app');
  });

  it('does not send an npmrc scoped registry to public npm through Modern Yarn', async () => {
    resolveYarnFamilyMock.mockResolvedValueOnce({ family: 'modern', source: 'package-manager' });
    mockNpmrcFiles({
      '/workspace/.npmrc': '@acme:registry=https://internal.acme.test/npm/',
      '/workspace/.yarnrc.yml': 'npmRegistryServer: https://registry.npmjs.org/',
    });

    await expect(fetchPackageMetadataFromRegistry(
      '@acme/secret-app',
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

  it('reads the user Modern Yarn config and its scoped registry', async () => {
    resolveYarnFamilyMock.mockResolvedValueOnce({ family: 'modern', source: 'package-manager' });
    mockNpmrcFiles({
      '/home/user/.yarnrc.yml': [
        'npmScopes:',
        '  acme:',
        '    npmRegistryServer: https://home.acme.test/npm/',
      ].join('\n'),
    });
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));

    await fetchPackageMetadataFromRegistry(
      '@acme/pkg',
      '/workspace/package.json',
      undefined,
      'yarn',
    );

    expectRegistryUrl('https://home.acme.test/npm/@acme%2Fpkg');
  });

  it('binds top-level Modern Yarn credentials to their registry host and path', async () => {
    resolveYarnFamilyMock.mockResolvedValueOnce({ family: 'modern', source: 'package-manager' });
    mockNpmrcFiles({
      '/workspace/.yarnrc.yml': [
        'npmRegistryServer: https://top-level.example.com/npm/',
        'npmAuthToken: top-level-token',
        'npmScopes:',
        '  acme:',
        '    npmRegistryServer: https://scope.example.com/npm/',
      ].join('\n'),
    });
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));

    await fetchPackageMetadataFromRegistry(
      '@acme/pkg',
      '/workspace/package.json',
      undefined,
      'yarn',
    );

    expectRegistryUrl('https://scope.example.com/npm/@acme%2Fpkg');
    expect(vi.mocked(https.get).mock.calls[0][1]).not.toMatchObject({
      headers: { Authorization: 'Bearer top-level-token' },
    });
  });

  it('prefers the nearest Modern Yarn config and scoped settings over top-level values', async () => {
    resolveYarnFamilyMock.mockResolvedValueOnce({ family: 'modern', source: 'project-markers' });
    mockNpmrcFiles({
      '/workspace/.yarnrc.yml': [
        'npmRegistryServer: https://root.example.com',
        'npmScopes:',
        '  acme:',
        '    npmRegistryServer: https://root-acme.example.com',
      ].join('\n'),
      '/workspace/packages/app/.yarnrc.yml': [
        'npmRegistryServer: https://nested.example.com',
        'npmScopes:',
        '  acme:',
        '    npmRegistryServer: https://nested-acme.example.com/npm/',
        '    npmAuthIdent: "alice:secret"',
      ].join('\n'),
    });
    mockRegistryResponse(JSON.stringify({ 'dist-tags': {}, versions: { '1.0.0': {} } }));

    await fetchPackageMetadataFromRegistry(
      '@acme/pkg',
      '/workspace/packages/app/package.json',
      undefined,
      'yarn',
    );

    expectRegistryUrl('https://nested-acme.example.com/npm/@acme%2Fpkg');
    expectRequestHeaders({ Authorization: 'Basic YWxpY2U6c2VjcmV0' });
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
      tier: 'public-npm',
      packageManagers: ['yarn'],
      fetchMetadata: vi.fn().mockResolvedValue({
        kind: 'success',
        result: { distTags: {}, publishTimes: { kind: 'not-provided' }, versions: ['9.9.9'] },
      }),
    };

    await expect(new MetadataAdapterRegistry([
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
      tier: 'public-npm',
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
    expect(parseNpmRegistryMetadata(null)).toEqual({ kind: 'unrecognized' });
    expect(parseNpmRegistryMetadata({})).toEqual({ kind: 'unrecognized' });
    expect(parseNpmRegistryMetadata({ 'dist-tags': [], versions: {} })).toEqual({ kind: 'malformed' });
  });
});

describe('Yarn configuration parsers', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('parses the supported Classic keys and ignores other Yarn settings', () => {
    expect(parseClassicYarnConfig([
      '# comment',
      '--registry "https://registry.example.com/npm/"',
      'proxy "https://proxy.example.com"',
      'https-proxy https://secure-proxy.example.com',
      'ca "inline-ca"',
      'cafile ./company-ca.pem',
      'strict-ssl false',
      'no-proxy registry.example.com',
      'cache-folder ".yarn-cache"',
      '',
    ].join('\n'))).toEqual(new Map([
      ['registry', 'https://registry.example.com/npm/'],
      ['proxy', 'https://proxy.example.com'],
      ['https-proxy', 'https://secure-proxy.example.com'],
      ['ca', 'inline-ca'],
      ['cafile', './company-ca.pem'],
      ['strict-ssl', 'false'],
      ['no-proxy', 'registry.example.com'],
    ]));
  });

  it('fails closed on a malformed Classic supported value', () => {
    expect(() => parseClassicYarnConfig('registry "unterminated')).toThrow();
    expect(parseClassicYarnConfig('registry')).toEqual(new Map());
  });

  it('parses Modern scalar and flow-map settings while ignoring unrelated blocks', () => {
    vi.stubEnv('YARN_TOKEN', 'env-token');
    const parsed = parseYarnModernConfig([
      'npmRegistryServer: "https://registry.example.com/npm/" # comment',
      'npmAuthToken: ${YARN_TOKEN}',
      'npmAuthIdent: "alice:secret"',
      'httpProxy: https://proxy.example.com',
      'httpsProxy: https://secure-proxy.example.com',
      'caFilePath: ./company-ca.pem',
      'enableStrictSsl: false',
      'noProxy: registry.example.com',
      'npmScopes: { @acme: { npmRegistryServer: "https://acme.example.com", npmAuthToken: token } }',
      'plugins:',
      '  - path: .yarn/plugins/@yarnpkg/plugin-npm.cjs',
    ].join('\n'));

    expect(parsed).toMatchObject({
      registryUrl: 'https://registry.example.com/npm/',
      authToken: 'env-token',
      authIdent: 'alice:secret',
      httpProxy: 'https://proxy.example.com',
      httpsProxy: 'https://secure-proxy.example.com',
      caFilePath: './company-ca.pem',
      enableStrictSsl: false,
      noProxy: 'registry.example.com',
    });
    expect(parsed?.scopes).toEqual(new Map([
      ['acme', { registryUrl: 'https://acme.example.com', authToken: 'token', authIdent: undefined }],
    ]));
  });

  it('parses block scopes and rejects unsupported or malformed YAML constructs', () => {
    expect(parseYarnModernConfig([
      'npmScopes:',
      '  acme:',
      '    npmRegistryServer: https://acme.example.com',
      '    npmAuthToken: token',
      '  other:',
      '    npmAuthIdent: "alice:secret"',
    ].join('\n'))?.scopes).toEqual(new Map([
      ['acme', { registryUrl: 'https://acme.example.com', authToken: 'token', authIdent: undefined }],
      ['other', { registryUrl: undefined, authToken: undefined, authIdent: 'alice:secret' }],
    ]));
    expect(parseYarnModernConfig('enableStrictSsl: maybe')).toBeUndefined();
    expect(parseYarnModernConfig('npmRegistryServer: [unsupported]')).toBeUndefined();
    expect(parseYarnModernConfig('npmScopes: { acme: [unsupported] }')).toBeUndefined();
    expect(parseYarnModernConfig('npmScopes: { acme: { npmAuthToken: "unterminated } }')).toBeUndefined();
    expect(parseYarnModernConfig('npmScopes: { acme: { npmRegistryServer: https://acme.example.com }')).toBeUndefined();
    expect(parseYarnModernConfig('npmScopes:\n  acme:\n    npmAuthToken: token\n      bad: value')).toBeUndefined();
    expect(parseYarnModernConfig('\tnpmRegistryServer: https://registry.example.com')).toBeUndefined();
    expect(parseYarnModernConfig('not-a-yaml-entry')).toBeUndefined();
    expect(parseYarnModernConfig('npmRegistryServer: "unterminated')).toBeUndefined();
  });

  it('rejects invalid scope entries and unsupported scalar forms', () => {
    expect(parseYarnModernConfig('npmScopes: { "bad scope": { npmAuthToken: token } }')).toBeUndefined();
    expect(parseYarnModernConfig('npmScopes: { acme: { npmAuthToken: [token] } }')).toBeUndefined();
    expect(parseYarnModernConfig('npmAuthToken: null')).toBeUndefined();
    expect(parseYarnModernConfig('npmAuthToken: &token value')).toBeUndefined();
    expect(parseYarnModernConfig('npmAuthToken: *token')).toBeUndefined();
    expect(parseYarnModernConfig('npmAuthToken: |\n  token')).toBeUndefined();
    expect(parseYarnModernConfig('npmAuthToken: "token # not a comment"')).toMatchObject({
      authToken: 'token # not a comment',
    });
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

function mockRegistryResponse(body: string, statusCode = 200, location?: string): void {
  vi.mocked(https.get).mockImplementationOnce((_url, _options, callback) => {
    const response = new EventEmitter() as IncomingMessage;
    response.statusCode = statusCode;
    response.headers = location === undefined ? {} : { location };
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

function expectRequestHeaders(expected: Record<string, string>): void {
  expect(vi.mocked(https.get).mock.calls[0][1]).toMatchObject({
    headers: expect.objectContaining(expected),
  });
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