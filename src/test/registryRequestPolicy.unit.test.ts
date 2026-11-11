import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthorizationHeader } from '../utils/registry/auth';
import type { RegistryCredentials } from '../utils/registry/auth';
import { getNoProxyConfiguration, isNoProxyHost } from '../utils/registry/proxy';
import { buildRegistryPackageUrl, normalizeRegistryUrl } from '../utils/registry/registryUrl';
import { parseStrictSsl, resolveCa, resolveYarnCa } from '../utils/registry/tls';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

function credentials(overrides: Partial<RegistryCredentials> = {}): RegistryCredentials {
  return { config: new Map(), authToken: undefined, authIdent: undefined, authRegistryUrl: undefined, ...overrides };
}

describe('getAuthorizationHeader()', () => {
  it('prefers the longest matching scoped npm credential', () => {
    const config = new Map([
      ['//registry.example.com/:_authToken', 'root'],
      ['//registry.example.com/npm/:_authToken', 'nested'],
    ]);

    expect(getAuthorizationHeader('https://registry.example.com/npm/react', credentials({ config })))
      .toBe('Bearer nested');
  });

  it('builds Basic credentials from a username and base64 password', () => {
    const config = new Map([
      ['//registry.example.com/:username', 'alice'],
      ['//registry.example.com/:_password', Buffer.from('secret').toString('base64')],
    ]);

    expect(getAuthorizationHeader('https://registry.example.com/react', credentials({ config })))
      .toBe(`Basic ${Buffer.from('alice:secret').toString('base64')}`);
  });

  it('applies Yarn and Bun credentials only beneath their registry', () => {
    const yarn = credentials({ authToken: 'tok', authRegistryUrl: 'https://registry.example.com/npm/' });

    expect(getAuthorizationHeader('https://registry.example.com/npm/react', yarn)).toBe('Bearer tok');
    expect(getAuthorizationHeader('https://registry.example.com/other/react', yarn)).toBeUndefined();
    expect(getAuthorizationHeader('https://evil.example.com/npm/react', yarn)).toBeUndefined();
  });

  it('base64-encodes a Yarn identity only when it holds a colon', () => {
    const base = { authRegistryUrl: 'https://registry.example.com/' };

    expect(getAuthorizationHeader('https://registry.example.com/x', credentials({ ...base, authIdent: 'a:b' })))
      .toBe(`Basic ${Buffer.from('a:b').toString('base64')}`);
    expect(getAuthorizationHeader('https://registry.example.com/x', credentials({ ...base, authIdent: 'YTpi' })))
      .toBe('Basic YTpi');
  });

  it('sends nothing without credentials', () => {
    expect(getAuthorizationHeader('https://registry.example.com/x', credentials())).toBeUndefined();
  });
});

describe('proxy bypass', () => {
  beforeEach(() => {
    vi.stubEnv('NO_PROXY', '');
    vi.stubEnv('no_proxy', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('joins non-empty entries from Yarn, npm config and the environment', () => {
    vi.stubEnv('NO_PROXY', 'env.example.com');

    expect(getNoProxyConfiguration(new Map([['no-proxy', 'npm.example.com']]), 'yarn.example.com'))
      .toBe('yarn.example.com,npm.example.com,env.example.com');
  });

  it('is undefined when no entry is set', () => {
    expect(getNoProxyConfiguration(new Map(), undefined)).toBeUndefined();
  });

  it('matches wildcard, exact and suffix entries', () => {
    expect(isNoProxyHost('registry.example.com', '*')).toBe(true);
    expect(isNoProxyHost('Registry.Example.com.', 'registry.example.com')).toBe(true);
    expect(isNoProxyHost('registry.example.com', '.example.com')).toBe(true);
    expect(isNoProxyHost('example.com', '.example.com')).toBe(true);
    expect(isNoProxyHost('notexample.com', '.example.com')).toBe(false);
    expect(isNoProxyHost('registry.example.com', undefined)).toBe(false);
  });
});

describe('registry URLs', () => {
  it('requires HTTPS and drops embedded credentials', () => {
    expect(normalizeRegistryUrl('https://user:pass@registry.example.com/npm/')).toBe('https://registry.example.com/npm/');
    expect(() => normalizeRegistryUrl('http://registry.example.com/')).toThrow('Registry URL must use HTTPS.');
  });

  it('appends the encoded package name beneath the registry path', () => {
    expect(buildRegistryPackageUrl('https://registry.example.com/npm', '@scope%2Fname'))
      .toBe('https://registry.example.com/npm/@scope%2Fname');
  });
});

describe('TLS settings', () => {
  beforeEach(() => {
    vi.mocked(readFile).mockReset();
  });

  it('reads strict-ssl spellings', () => {
    expect(parseStrictSsl('FALSE')).toBe(false);
    expect(parseStrictSsl('0')).toBe(false);
    expect(parseStrictSsl('true')).toBe(true);
    expect(parseStrictSsl('1')).toBe(true);
    expect(parseStrictSsl('maybe')).toBeUndefined();
    expect(parseStrictSsl(undefined)).toBeUndefined();
  });

  it('prefers the inline ca over cafile and expands escaped newlines', async () => {
    await expect(resolveCa(new Map([['ca', 'a\\nb'], ['cafile', '/ca.pem']]))).resolves.toBe('a\nb');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('reads cafile when no inline ca is set', async () => {
    vi.mocked(readFile).mockResolvedValue('PEM');

    await expect(resolveCa(new Map([['cafile', '/ca.pem']]))).resolves.toBe('PEM');
    await expect(resolveCa(new Map())).resolves.toBeUndefined();
  });

  it('resolves a Yarn caFilePath against the config file directory', async () => {
    vi.mocked(readFile).mockResolvedValue('PEM');

    await expect(resolveYarnCa({ caFilePath: 'certs/ca.pem', caFileBasePath: '/workspace' })).resolves.toBe('PEM');
    expect(readFile).toHaveBeenCalledWith('/workspace/certs/ca.pem', 'utf8');
  });
});