import path from 'node:path';
import { YARN_DIALECTS } from '../../shared';
import { resolveYarnFamily } from '../yarnFamily';
import { getConfigFilePaths, getPackageRoot, readConfigFile } from './configFiles';
import { DEFAULT_REGISTRY_URL } from './registryUrl';
import { readClassicYarnConfiguration } from './yarnrc';
import { parseYarnModernConfig } from './yarnrcYml';
import type { ParsedYarnModernConfig, YarnScopeConfiguration } from './yarnrcYml';

export type { YarnScopeConfiguration } from './yarnrcYml';

export interface YarnConfiguration {
  sourceFound: boolean;
  registryUrl: string | undefined;
  authToken: string | undefined;
  authIdent: string | undefined;
  httpProxy: string | undefined;
  httpsProxy: string | undefined;
  caFilePath: string | undefined;
  caFileBasePath: string | undefined;
  enableStrictSsl: boolean | undefined;
  noProxy: string | undefined;
  scopes: ReadonlyMap<string, YarnScopeConfiguration>;
}

/** The Yarn configuration that applies to a package: Modern settings or Classic npm-style values, never both. */
export interface YarnSources {
  modern: YarnConfiguration | undefined;
  classicValues: ReadonlyMap<string, string> | undefined;
}

export interface YarnConfigurationWithCa extends YarnConfiguration {
  caFilePath: string;
  caFileBasePath: string;
}

/** Reads the config files of the Yarn family the project uses; throws when the family or its files are ambiguous. */
export async function readYarnSources(packageFilePath: string | undefined): Promise<YarnSources> {
  const packageRoot = getPackageRoot(packageFilePath);
  const family = packageRoot === undefined
    ? { family: 'unknown' as const, source: 'version-probe' as const }
    : await resolveYarnFamily(packageRoot);
  if (family.source === 'conflicting-markers') {
    throw new Error('Yarn family is ambiguous.');
  }
  if (family.family === 'modern') {
    return { modern: await readYarnModernConfiguration(packageFilePath), classicValues: undefined };
  }
  if (family.family === 'classic') {
    return { modern: undefined, classicValues: (await readClassicYarnConfiguration(packageFilePath)).values };
  }

  const [modern, classic] = await Promise.all([
    readYarnModernConfiguration(packageFilePath),
    readClassicYarnConfiguration(packageFilePath),
  ]);
  if (modern.sourceFound && classic.sourceFound) {
    throw new Error('Yarn family is ambiguous.');
  }
  if (modern.sourceFound) {
    return { modern, classicValues: undefined };
  }
  return { modern: undefined, classicValues: classic.sourceFound ? classic.values : undefined };
}

export function isYarnConfigurationWithCa(config: YarnConfiguration): config is YarnConfigurationWithCa {
  return config.caFilePath !== undefined && config.caFileBasePath !== undefined;
}

/** The registry the unscoped Yarn credentials belong to: the scope's own when it carries credentials. */
export function getYarnAuthRegistryUrl(
  config: YarnConfiguration,
  scope: YarnScopeConfiguration | undefined,
): string {
  const scopeAuthConfigured = scope?.authToken !== undefined || scope?.authIdent !== undefined;
  return scopeAuthConfigured
    ? scope.registryUrl ?? config.registryUrl ?? DEFAULT_REGISTRY_URL
    : config.registryUrl ?? DEFAULT_REGISTRY_URL;
}

async function readYarnModernConfiguration(
  packageFilePath: string | undefined,
): Promise<YarnConfiguration> {
  const config: YarnConfiguration = {
    sourceFound: false,
    registryUrl: undefined,
    authToken: undefined,
    authIdent: undefined,
    httpProxy: undefined,
    httpsProxy: undefined,
    caFilePath: undefined,
    caFileBasePath: undefined,
    enableStrictSsl: undefined,
    noProxy: undefined,
    scopes: new Map(),
  };
  for (const configPath of getConfigFilePaths(packageFilePath, YARN_DIALECTS.modern.configFile)) {
    const contents = await readConfigFile(configPath);
    if (contents === undefined) {
      continue;
    }
    config.sourceFound = true;
    const parsed = parseYarnModernConfig(contents);
    if (parsed === undefined) {
      throw new Error('Malformed Yarn Modern configuration.');
    }
    mergeYarnModernConfig(config, parsed, path.dirname(configPath));
  }
  return config;
}

function mergeYarnModernConfig(
  target: YarnConfiguration,
  source: ParsedYarnModernConfig,
  sourceDirectory: string,
): void {
  target.registryUrl = source.registryUrl ?? target.registryUrl;
  target.authToken = source.authToken ?? target.authToken;
  target.authIdent = source.authIdent ?? target.authIdent;
  target.httpProxy = source.httpProxy ?? target.httpProxy;
  target.httpsProxy = source.httpsProxy ?? target.httpsProxy;
  target.enableStrictSsl = source.enableStrictSsl ?? target.enableStrictSsl;
  target.noProxy = source.noProxy ?? target.noProxy;
  if (source.caFilePath !== undefined) {
    target.caFilePath = source.caFilePath;
    target.caFileBasePath = sourceDirectory;
  }
  for (const [scope, values] of source.scopes) {
    const previous = target.scopes.get(scope);
    target.scopes = new Map(target.scopes).set(scope, {
      registryUrl: values.registryUrl ?? previous?.registryUrl,
      authToken: values.authToken ?? previous?.authToken,
      authIdent: values.authIdent ?? previous?.authIdent,
    });
  }
}