import type { BunRegistryConfiguration, ParsedBunConfig } from '../bunConfig';
import type { PackageManager } from '../../shared';
import { memoizeRegistrySource } from './configSourceMemo';
import { getBunAuthConfiguration, readBunConfiguration } from './bunConfiguration';
import { getNoProxyConfiguration } from './proxy';
import { getScopeConfiguration } from './packageScope';
import { getScopedRegistry, readNpmrcConfig } from './npmrc';
import { DEFAULT_REGISTRY_URL } from './registryUrl';
import { parseStrictSsl, resolveCa, resolveYarnCa } from './tls';
import { getYarnAuthRegistryUrl, isYarnConfigurationWithCa, readYarnSources } from './yarnConfiguration';
import type { YarnConfiguration, YarnScopeConfiguration, YarnSources } from './yarnConfiguration';

export interface RegistryConfiguration {
  registryUrl: string;
  registryConfigured: boolean;
  privateRegistryUnresolved: boolean;
  values: ReadonlyMap<string, string>;
  proxyConfigured: boolean;
  noProxy: string | undefined;
  ca: string | undefined;
  rejectUnauthorized: boolean | undefined;
  authToken: string | undefined;
  authIdent: string | undefined;
  authRegistryUrl: string | undefined;
}

interface ConfigurationSources {
  packageName: string;
  packageManager: PackageManager | undefined;
  /** npm-style settings in effect; empty when Yarn Modern supplies the configuration. */
  values: ReadonlyMap<string, string>;
  bun: ParsedBunConfig | undefined;
  bunScope: BunRegistryConfiguration | undefined;
  yarn: YarnConfiguration | undefined;
  yarnScope: YarnScopeConfiguration | undefined;
}

/** Merges the npm, Yarn and Bun configuration that applies to a package into one registry configuration. */
export async function resolveRegistryConfiguration(
  packageName: string,
  packageFilePath: string | undefined,
  packageManager: PackageManager | undefined,
): Promise<RegistryConfiguration> {
  const npmrcValues = await memoizeRegistrySource(
    'npmrc',
    packageFilePath,
    () => readNpmrcConfig(packageFilePath),
  );
  const bun = packageManager === 'bun'
    ? await memoizeRegistrySource('bun', packageFilePath, () => readBunConfiguration(packageFilePath))
    : undefined;
  const yarnSources = packageManager === 'yarn'
    ? await memoizeRegistrySource('yarn', packageFilePath, () => readYarnSources(packageFilePath))
    : undefined;
  const yarn = yarnSources?.modern;
  const sources: ConfigurationSources = {
    packageName,
    packageManager,
    values: selectNpmValues(npmrcValues, yarnSources),
    bun,
    bunScope: bun === undefined ? undefined : getScopeConfiguration(packageName, bun.scopes),
    yarn,
    yarnScope: yarn === undefined ? undefined : getScopeConfiguration(packageName, yarn.scopes),
  };

  const configuredRegistry = selectConfiguredRegistry(sources);
  const auth = selectAuthentication(sources);
  return {
    registryUrl: configuredRegistry ?? DEFAULT_REGISTRY_URL,
    registryConfigured: configuredRegistry !== undefined,
    privateRegistryUnresolved: packageManager === 'yarn'
      && yarn !== undefined
      && getScopedRegistry(packageName, npmrcValues) !== undefined
      && sources.yarnScope?.registryUrl === undefined,
    values: sources.values,
    proxyConfigured: isProxyConfigured(sources),
    noProxy: getNoProxyConfiguration(sources.values, yarn?.noProxy),
    ca: yarn !== undefined && isYarnConfigurationWithCa(yarn)
      ? await resolveYarnCa(yarn)
      : await resolveCa(sources.values),
    rejectUnauthorized: yarn?.enableStrictSsl ?? parseStrictSsl(sources.values.get('strict-ssl')),
    ...auth,
  };
}

function selectNpmValues(
  npmrcValues: ReadonlyMap<string, string>,
  yarnSources: YarnSources | undefined,
): ReadonlyMap<string, string> {
  if (yarnSources?.modern !== undefined) {
    return new Map();
  }
  return yarnSources?.classicValues === undefined
    ? npmrcValues
    : new Map([...npmrcValues, ...yarnSources.classicValues]);
}

function selectConfiguredRegistry(sources: ConfigurationSources): string | undefined {
  const { packageName, packageManager, values, bun, bunScope, yarn, yarnScope } = sources;
  const bunScopedRegistry = bunScope?.registryUrl
    ?? (packageManager === 'bun' ? getScopedRegistry(packageName, values) : undefined);
  const bunRegistry = bunScopedRegistry ?? bun?.registry?.registryUrl;
  const scopedRegistry = bunRegistry
    ?? yarnScope?.registryUrl
    ?? yarn?.registryUrl
    ?? getScopedRegistry(packageName, values);
  return scopedRegistry ?? values.get('registry');
}

function selectAuthentication(sources: ConfigurationSources): {
  authToken: string | undefined;
  authIdent: string | undefined;
  authRegistryUrl: string | undefined;
} {
  const { bun, bunScope, yarn, yarnScope } = sources;
  const bunAuth = getBunAuthConfiguration(bun, bunScope);
  return {
    authToken: bunAuth?.authToken ?? yarnScope?.authToken ?? yarn?.authToken,
    authIdent: bunAuth?.authIdent ?? yarnScope?.authIdent ?? yarn?.authIdent,
    authRegistryUrl: bunAuth?.authRegistryUrl ?? (yarn === undefined
      ? undefined
      : getYarnAuthRegistryUrl(yarn, yarnScope)),
  };
}

function isProxyConfigured(sources: ConfigurationSources): boolean {
  const { values, yarn } = sources;
  const httpsProxy = yarn?.httpsProxy ?? values.get('https-proxy');
  const proxy = httpsProxy ?? (yarn === undefined ? values.get('proxy') : yarn.httpProxy);
  return proxy !== undefined && proxy.trim() !== '';
}