import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseBunConfig } from '../utils/bunConfig';
import { expandEnvironmentReferences, NPM_ENV_SYNTAX, YARN_MODERN_ENV_SYNTAX } from '../utils/envExpansion';
import { readNpmrcConfig } from '../utils/registry/npmrc';
import { parseClassicYarnConfig } from '../utils/registry/yarnrc';
import { parseYarnModernConfig } from '../utils/registry/yarnrcYml';

vi.mock('../utils/registry/configFiles', () => ({
  getConfigFilePaths: vi.fn(() => ['/workspace/.npmrc']),
  getPackageRoot: vi.fn(() => '/workspace'),
  readConfigFile: vi.fn(),
}));

const SET = 'NESTRO_ENV_SET';
const EMPTY = 'NESTRO_ENV_EMPTY';
const UNSET = 'NESTRO_ENV_UNSET';

beforeEach(() => {
  vi.stubEnv(SET, 'secret-value');
  vi.stubEnv(EMPTY, '');
  delete process.env[UNSET];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function readNpmrcToken(reference: string): Promise<string | undefined> {
  const { readConfigFile } = await import('../utils/registry/configFiles');
  vi.mocked(readConfigFile).mockResolvedValue(`//registry.example.com/:_authToken=${reference}`);
  return (await readNpmrcConfig('/workspace/package.json')).get('//registry.example.com/:_authToken');
}

function readClassicRegistry(reference: string): string | undefined {
  return parseClassicYarnConfig(`registry "${reference}"`).get('registry');
}

function readModernToken(reference: string): string | undefined {
  return parseYarnModernConfig(`npmAuthToken: "${reference}"`)?.authToken;
}

function readBunToken(reference: string): string | undefined {
  return parseBunConfig(`[install]\nregistry = { url = "https://registry.example.com/", token = "${reference}" }`)
    ?.registry?.authToken;
}

describe('npmrc environment references', () => {
  it.each([
    ['${NAME} set', `\${${SET}}`, 'secret-value'],
    ['${NAME} set but empty', `\${${EMPTY}}`, ''],
    ['${NAME} unset stays literal', `\${${UNSET}}`, `\${${UNSET}}`],
    ['${NAME?} set', `\${${SET}?}`, 'secret-value'],
    ['${NAME?} unset is empty', `\${${UNSET}?}`, ''],
    ['$NAME is not a reference', `$${SET}`, `$${SET}`],
    ['text around a reference', `a-\${${SET}}-b`, 'a-secret-value-b'],
  ])('%s', async (_name, reference, expected) => {
    expect(await readNpmrcToken(reference)).toBe(expected);
  });
});

describe('Yarn Classic environment references', () => {
  it.each([
    ['${NAME} set', `\${${SET}}`, 'secret-value'],
    ['${NAME} set but empty', `\${${EMPTY}}`, ''],
    ['text around a reference', `a-\${${SET}}-b`, 'a-secret-value-b'],
    ['$NAME is not a reference', `$${SET}`, `$${SET}`],
  ])('%s', (_name, reference, expected) => {
    expect(readClassicRegistry(reference)).toBe(expected);
  });

  it('rejects the whole file for an unset variable without echoing the reference', () => {
    expect(() => readClassicRegistry(`\${${UNSET}}`)).toThrow('Yarn Classic configuration references an unset environment variable.');
    expect(() => readClassicRegistry(`\${${UNSET}}`)).not.toThrow(UNSET);
  });
});

describe('Yarn Modern environment references', () => {
  it.each([
    ['${NAME} set', `\${${SET}}`, 'secret-value'],
    ['${NAME} unset is rejected', `\${${UNSET}}`, undefined],
    ['${NAME:-fallback} set', `\${${SET}:-fallback}`, 'secret-value'],
    ['${NAME:-fallback} set but empty', `\${${EMPTY}:-fallback}`, 'fallback'],
    ['${NAME:-fallback} unset', `\${${UNSET}:-fallback}`, 'fallback'],
    ['${NAME-fallback} set but empty', `\${${EMPTY}-fallback}`, ''],
    ['${NAME-fallback} unset', `\${${UNSET}-fallback}`, 'fallback'],
    ['${NAME:-} unset is empty', `\${${UNSET}:-}`, ''],
    ['nested expansion is rejected', `\${${UNSET}:-\${${SET}}}`, undefined],
    ['$NAME is not a reference', `$${SET}`, `$${SET}`],
  ])('%s', (_name, reference, expected) => {
    expect(readModernToken(reference)).toBe(expected);
  });

  it('rejects an unset variable inside a flow-mapped scope', () => {
    expect(parseYarnModernConfig(`npmScopes: { acme: { npmAuthToken: "\${${UNSET}}" } }`)).toBeUndefined();
    expect(parseYarnModernConfig(`npmScopes: { acme: { npmAuthToken: "\${${SET}}" } }`)?.scopes.get('acme')?.authToken)
      .toBe('secret-value');
  });
});

describe('Bun environment references', () => {
  it.each([
    ['$NAME set', `$${SET}`, 'secret-value'],
    ['${NAME} set', `\${${SET}}`, 'secret-value'],
    ['$NAME set but empty', `$${EMPTY}`, ''],
    ['$NAME unset is rejected', `$${UNSET}`, undefined],
    ['${NAME} unset is rejected', `\${${UNSET}}`, undefined],
    ['${NAME?} is not a reference', `\${${SET}?}`, `\${${SET}?}`],
  ])('%s', (_name, reference, expected) => {
    expect(readBunToken(reference)).toBe(expected);
  });
});

describe('expandEnvironmentReferences()', () => {
  it('reads the supplied environment instead of process.env', () => {
    expect(expandEnvironmentReferences('${A}-${B?}', NPM_ENV_SYNTAX, { A: 'x' })).toBe('x-');
  });

  it('expands every reference and keeps the text between them', () => {
    expect(expandEnvironmentReferences('${A}/${A}:${B-d}', YARN_MODERN_ENV_SYNTAX, { A: '1' })).toBe('1/1:d');
  });

  it('returns undefined for an unclosed reference in a strict syntax', () => {
    expect(expandEnvironmentReferences('${A', YARN_MODERN_ENV_SYNTAX, { A: '1' })).toBeUndefined();
  });
});