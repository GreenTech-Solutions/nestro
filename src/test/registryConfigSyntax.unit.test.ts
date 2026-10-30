import { afterEach, describe, expect, it, vi } from 'vitest';
import { unwrapQuotes } from '../utils/registry/configValues';
import { parseYamlEntry, parseYamlFlowMap, parseYamlScalar, readYamlLines, skipYamlBlock } from '../utils/registry/miniYaml';
import { getScopedRegistry, normalizeSimpleConfigKey, parseAuthConfigKey } from '../utils/registry/npmrc';
import { getPackageScope, getScopeConfiguration } from '../utils/registry/packageScope';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('unwrapQuotes()', () => {
  it('unwraps a matching pair of either quote', () => {
    expect(unwrapQuotes('"a b"')).toBe('a b');
    expect(unwrapQuotes('\'a b\'')).toBe('a b');
  });

  it('rejects mismatched, partial and unquoted text', () => {
    expect(unwrapQuotes('"a\'')).toBeUndefined();
    expect(unwrapQuotes('"open')).toBeUndefined();
    expect(unwrapQuotes('plain')).toBeUndefined();
    expect(unwrapQuotes('')).toBeUndefined();
  });
});

describe('getPackageScope()', () => {
  it('returns the scope without the at sign', () => {
    expect(getPackageScope('@types/node')).toBe('types');
  });

  it('is undefined for unscoped and malformed names', () => {
    expect(getPackageScope('react')).toBeUndefined();
    expect(getPackageScope('@types')).toBeUndefined();
    expect(getPackageScope('@/node')).toBeUndefined();
  });

  it('selects scope maps and scoped registries by the same rule', () => {
    expect(getScopeConfiguration('@acme/tool', new Map([['acme', 'cfg']]))).toBe('cfg');
    expect(getScopeConfiguration('tool', new Map([['acme', 'cfg']]))).toBeUndefined();
    expect(getScopedRegistry('@acme/tool', new Map([['@acme:registry', 'https://r/']]))).toBe('https://r/');
    expect(getScopedRegistry('@/tool', new Map([['@:registry', 'https://r/']]))).toBeUndefined();
  });
});

describe('npmrc keys', () => {
  it('normalizes the settings npm and Yarn Classic share', () => {
    expect(normalizeSimpleConfigKey('HTTPS_PROXY')).toBe('https-proxy');
    expect(normalizeSimpleConfigKey('Strict-SSL')).toBe('strict-ssl');
    expect(normalizeSimpleConfigKey('color')).toBeUndefined();
  });

  it('splits scoped auth keys into a normalized scope and property', () => {
    expect(parseAuthConfigKey('//Registry.Example.com/npm/:_authtoken')).toEqual({
      scopeKey: '//registry.example.com/npm/',
      origin: 'https://registry.example.com',
      pathname: '/npm/',
      property: '_authToken',
    });
    expect(parseAuthConfigKey('//host/:unknown')).toBeUndefined();
    expect(parseAuthConfigKey('registry')).toBeUndefined();
  });
});

describe('mini YAML', () => {
  it('drops comments and blank lines and rejects tab indentation', () => {
    expect(readYamlLines('# c\n\na: 1 # trailing\n  b: "x # y"\n')).toEqual([
      { indent: 0, content: 'a: 1' },
      { indent: 2, content: 'b: "x # y"' },
    ]);
    expect(readYamlLines('a:\n\tb: 1')).toBeUndefined();
  });

  it('splits entries on plain identifier keys only', () => {
    expect(parseYamlEntry('npmScopes: {}')).toEqual({ key: 'npmScopes', value: '{}' });
    expect(parseYamlEntry('"quoted": 1')).toBeUndefined();
    expect(parseYamlEntry(': 1')).toBeUndefined();
  });

  it('skips the nested block under a parent', () => {
    const lines = [
      { indent: 0, content: 'a:' },
      { indent: 2, content: 'b: 1' },
      { indent: 4, content: 'c: 2' },
      { indent: 0, content: 'd: 3' },
    ];

    expect(skipYamlBlock(lines, 1, 0)).toBe(3);
  });

  it('parses booleans and expands environment variables in strings', () => {
    vi.stubEnv('NESTRO_YAML_TOKEN', 'secret');

    expect(parseYamlScalar('true')).toBe(true);
    expect(parseYamlScalar('"${NESTRO_YAML_TOKEN}"')).toBe('secret');
    expect(parseYamlScalar('bare-${NESTRO_YAML_TOKEN}')).toBe('bare-secret');
  });

  it('rejects unsupported scalars', () => {
    for (const value of ['', 'null', '~', '[a]', '&anchor', '*alias', '|', '>', '"open', 'a {b}']) {
      expect(parseYamlScalar(value)).toBeUndefined();
    }
  });

  it('parses nested flow maps and rejects duplicates and trailing text', () => {
    expect(parseYamlFlowMap('{ a: x, b: { c: "y" } }')).toEqual({ a: 'x', b: { c: 'y' } });
    expect(parseYamlFlowMap('{}')).toEqual({});
    expect(parseYamlFlowMap('{ a: x, a: y }')).toBeUndefined();
    expect(parseYamlFlowMap('{ a: x } extra')).toBeUndefined();
    expect(parseYamlFlowMap('{ a: x')).toBeUndefined();
  });
});