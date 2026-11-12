import { PACKAGE_MANAGERS } from '../../shared';
import { getConfigFilePaths, getPackageRoot, readConfigFile } from './configFiles';
import { expandEnvironmentReferences, NPM_ENV_SYNTAX } from '../envExpansion';
import { unwrapQuotes } from './configValues';
import { getPackageScope } from './packageScope';
import { resolveCaFilePath } from './tls';

const NPM_CONFIG_ENV_PREFIX = 'npm_config_';
const SIMPLE_CONFIG_KEYS = new Set([
  'registry',
  'proxy',
  'https-proxy',
  'ca',
  'cafile',
  'strict-ssl',
  'no-proxy',
]);
const AUTH_PROPERTIES = new Map([
  ['_authtoken', '_authToken'],
  ['_auth', '_auth'],
  ['username', 'username'],
  ['_password', '_password'],
]);

export interface AuthScope {
  scopeKey: string;
  origin: string;
  pathname: string;
}

/** The merged npm configuration: user `.npmrc`, project `.npmrc` files, then `npm_config_*` environment overrides. */
export async function readNpmrcConfig(packageFilePath: string | undefined): Promise<Map<string, string>> {
  const config = new Map<string, string>();
  const baseDirectory = getPackageRoot(packageFilePath) ?? process.cwd();
  for (const npmrcPath of getConfigFilePaths(packageFilePath, PACKAGE_MANAGERS.npm.dialect.configFile)) {
    mergeNpmrcConfig(config, await readConfigFile(npmrcPath) ?? '', baseDirectory);
  }
  applyEnvironmentOverrides(config, baseDirectory);
  return config;
}

/** The setting key shared by npm and Yarn Classic (`registry`, `https-proxy`, ...), or undefined for any other key. */
export function normalizeSimpleConfigKey(key: string): string | undefined {
  const dashedKey = key.toLowerCase().replaceAll('_', '-');
  return SIMPLE_CONFIG_KEYS.has(dashedKey) ? dashedKey : undefined;
}

/** The registry configured for the package's scope through `@scope:registry`. */
export function getScopedRegistry(packageName: string, config: ReadonlyMap<string, string>): string | undefined {
  const scope = getPackageScope(packageName);
  return scope === undefined ? undefined : config.get(`@${scope}:registry`);
}

/** Splits a `//host/path/:property` auth key into its registry scope and property; undefined for any other key. */
export function parseAuthConfigKey(key: string): (AuthScope & { property: string }) | undefined {
  if (!key.startsWith('//')) {
    return undefined;
  }

  const separatorIndex = key.indexOf('/:');
  if (separatorIndex <= 2) {
    return undefined;
  }
  const property = AUTH_PROPERTIES.get(key.slice(separatorIndex + 2).toLowerCase());
  if (property === undefined) {
    return undefined;
  }

  let scopeUrl: URL;
  try {
    scopeUrl = new URL(`https:${key.slice(0, separatorIndex + 1)}`);
  }
  catch {
    return undefined;
  }
  if (scopeUrl.hostname === '' || scopeUrl.username !== '' || scopeUrl.password !== '') {
    return undefined;
  }

  const pathname = scopeUrl.pathname.endsWith('/') ? scopeUrl.pathname : `${scopeUrl.pathname}/`;
  return {
    scopeKey: `//${scopeUrl.host}${pathname}`,
    origin: scopeUrl.origin,
    pathname,
    property,
  };
}

function mergeNpmrcConfig(config: Map<string, string>, npmrc: string, baseDirectory: string): void {
  for (const rawLine of npmrc.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = normalizeConfigKey(line.slice(0, separatorIndex).trim());
    if (key === undefined) {
      continue;
    }
    const value = line.slice(separatorIndex + 1).trim();
    config.set(key, normalizeConfigValue(key, expandNpmValue(unwrapQuotes(value) ?? value), baseDirectory));
  }
}

function applyEnvironmentOverrides(config: Map<string, string>, baseDirectory: string): void {
  for (const [environmentKey, environmentValue] of Object.entries(process.env)) {
    if (!environmentKey.toLowerCase().startsWith(NPM_CONFIG_ENV_PREFIX) || environmentValue === undefined) {
      continue;
    }
    const key = normalizeConfigKey(environmentKey.slice(NPM_CONFIG_ENV_PREFIX.length));
    if (key !== undefined) {
      config.set(key, normalizeConfigValue(key, expandNpmValue(environmentValue), baseDirectory));
    }
  }
}

function normalizeConfigValue(key: string, value: string, baseDirectory: string): string {
  return key === 'cafile' ? resolveCaFilePath(value, baseDirectory) : value;
}

function expandNpmValue(value: string): string {
  return expandEnvironmentReferences(value, NPM_ENV_SYNTAX) ?? value;
}

function normalizeConfigKey(key: string): string | undefined {
  const simpleKey = normalizeSimpleConfigKey(key);
  if (simpleKey !== undefined) {
    return simpleKey;
  }
  if (/^@[^:]+:registry$/i.test(key)) {
    const separatorIndex = key.indexOf(':');
    return `${key.slice(0, separatorIndex)}:registry`;
  }

  const auth = parseAuthConfigKey(key);
  return auth === undefined ? undefined : `${auth.scopeKey}:${auth.property}`;
}