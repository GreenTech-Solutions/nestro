import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseYarnModernConfig } from '../utils/registry/yarnrcYml';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('parseYarnModernConfig()', () => {
  it('reads the supported top-level keys and ignores unknown blocks', () => {
    vi.stubEnv('NESTRO_YML_TOKEN', 'tok');

    const parsed = parseYarnModernConfig([
      'npmRegistryServer: "https://registry.example.com/"',
      'npmAuthToken: ${NESTRO_YML_TOKEN}',
      'enableStrictSsl: false',
      'httpProxy: https://proxy:8080',
      'caFilePath: ./ca.pem',
      'unknownBlock:',
      '  nested: true',
    ].join('\n'));

    expect(parsed).toMatchObject({
      registryUrl: 'https://registry.example.com/',
      authToken: 'tok',
      enableStrictSsl: false,
      httpProxy: 'https://proxy:8080',
      caFilePath: './ca.pem',
    });
  });

  it('reads npmScopes entries in block and inline form', () => {
    const parsed = parseYarnModernConfig([
      'npmScopes:',
      '  acme:',
      '    npmRegistryServer: https://acme.example.com/',
      '    npmAuthIdent: user:pass',
      '    ignored: 1',
      '  other: { npmRegistryServer: "https://other.example.com/", extra: x }',
    ].join('\n'));

    expect(parsed?.scopes.get('acme')).toEqual({
      registryUrl: 'https://acme.example.com/',
      authToken: undefined,
      authIdent: 'user:pass',
    });
    expect(parsed?.scopes.get('other')?.registryUrl).toBe('https://other.example.com/');
  });

  it('reads a whole npmScopes flow map', () => {
    const parsed = parseYarnModernConfig('npmScopes: { acme: { npmAuthToken: t }, @other: { npmAuthIdent: i } }');

    expect(parsed?.scopes.get('acme')?.authToken).toBe('t');
    expect(parsed?.scopes.get('other')?.authIdent).toBe('i');
  });

  it('accepts an empty npmScopes block', () => {
    expect(parseYarnModernConfig('npmScopes:\nhttpProxy: https://p')?.scopes.size).toBe(0);
  });

  it('rejects malformed documents', () => {
    const malformed = [
      '\tnpmRegistryServer: https://r/',
      '  indented: first',
      'not a mapping entry',
      'npmRegistryServer:',
      'npmRegistryServer: [a]',
      'enableStrictSsl: yes-please',
      'httpProxy: false',
      'npmScopes: { acme: broken',
      'npmScopes: { "bad scope": { npmAuthToken: t } }',
      'npmScopes:\n  acme:\n    npmAuthToken:\n',
      'npmScopes:\n  acme:\n      npmAuthToken: t\n    npmRegistryServer: https://r/',
      'npmScopes:\n    acme:\n  other:',
      'npmScopes:\n  acme: { npmAuthToken: [x] }',
      'npmScopes:\n  acme: { npmAuthToken: { nested: x } }',
      'npmScopes:\n  acme: broken',
      'npmScopes:\n  "bad scope":\n    npmAuthToken: t',
      'npmScopes:\n  acme:\n    npmAuthToken: false',
      'npmScopes:\n  acme:\n    npmAuthToken: x\n   npmRegistryServer: y',
    ];

    for (const document of malformed) {
      expect(parseYarnModernConfig(document), JSON.stringify(document)).toBeUndefined();
    }
  });
});