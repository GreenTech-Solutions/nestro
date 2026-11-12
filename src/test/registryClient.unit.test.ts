import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseClassicYarnConfig } from '../utils/registry/yarnrc';
import { parseYarnModernConfig } from '../utils/registry/yarnrcYml';
import { selectVersionsForPicker } from '../utils/registryClient';

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