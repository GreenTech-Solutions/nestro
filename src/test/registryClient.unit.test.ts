import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import * as https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    vi.stubEnv('NO_PROXY', '');
    vi.stubEnv('no_proxy', '');
    vi.mocked(readFile).mockRejectedValue(new Error('missing npmrc'));
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
    });

    mockNpmrcFiles({ '/workspace/.npmrc': 'registry=https://registry.example.com' });
    mockRegistryResponse('', 302, 'https://[invalid');
    await expect(fetchPackageMetadataFromRegistry('invalid-url', '/workspace/package.json')).resolves.toEqual({
      kind: 'transport-error',
      reason: 'request',
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
    });
    expect(vi.mocked(https.get).mock.calls).toHaveLength(1);
    expectRegistryUrl('https://private.example.com/npm/@private%2Fpkg');
  });

  it('returns unavailable for an invalid configured registry instead of connecting elsewhere', async () => {
    mockNpmrcFiles({ '/workspace/.npmrc': 'registry=http://registry.example.com' });

    await expect(fetchPackageMetadataFromRegistry('react', '/workspace/package.json')).resolves.toEqual({
      kind: 'unavailable',
      reason: 'configuration-unavailable',
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