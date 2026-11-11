import { readFile } from 'node:fs/promises';
import * as https from 'node:https';
import * as vscode from 'vscode';
import { setWorkspaceFolders } from './fixtures';
import { expectRegistryUrl, expectRequestHeaders, mockNpmrcFiles, mockRegistryResponse } from './fixtures/registryClientHarness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPackageMetadataFromRegistry, resolvePackageRegistryUrl } from '../utils/registryClient';

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

  it('resolves the project registry without credentials for metadata deduplication', async () => {
    mockNpmrcFiles({
      '/workspace/.npmrc': 'registry=https://registry.example.com/npm/',
    });

    await expect(resolvePackageRegistryUrl('react', '/workspace/package.json', 'npm'))
      .resolves.toBe('https://registry.example.com/npm/');
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
});