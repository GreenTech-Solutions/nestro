import { PACKAGE_MANAGERS } from '../../shared';
import { parseBunConfig } from '../bunConfig';
import type { BunRegistryConfiguration, ParsedBunConfig } from '../bunConfig';
import { getConfigFilePaths, readConfigFile } from './configFiles';

/** The merged `bunfig.toml` files that apply to the package, user file first; throws on a malformed file. */
export async function readBunConfiguration(
  packageFilePath: string | undefined,
): Promise<ParsedBunConfig> {
  const config: ParsedBunConfig = {
    registry: undefined,
    scopes: new Map(),
  };
  for (const configPath of getConfigFilePaths(packageFilePath, PACKAGE_MANAGERS.bun.dialect.configFile)) {
    const contents = await readConfigFile(configPath);
    if (contents === undefined) {
      continue;
    }
    const parsed = parseBunConfig(contents);
    if (parsed === undefined) {
      throw new Error(`Malformed ${PACKAGE_MANAGERS.bun.dialect.configFile} at ${configPath}.`);
    }
    mergeBunConfig(config, parsed);
  }
  return config;
}

/** The credentials Bun sends: the scope's own when it carries any, else the default registry's. */
export function getBunAuthConfiguration(
  config: ParsedBunConfig | undefined,
  scope: BunRegistryConfiguration | undefined,
): { authToken: string | undefined; authIdent: string | undefined; authRegistryUrl: string } | undefined {
  const scopeHasAuth = scope?.authToken !== undefined || scope?.authIdent !== undefined;
  const entry = scopeHasAuth ? scope : config?.registry;
  if (entry === undefined || (entry.authToken === undefined && entry.authIdent === undefined)) {
    return undefined;
  }
  return {
    authToken: entry.authToken,
    authIdent: entry.authIdent,
    authRegistryUrl: entry.registryUrl,
  };
}

function mergeBunConfig(target: ParsedBunConfig, source: ParsedBunConfig): void {
  target.registry = source.registry ?? target.registry;
  for (const [scope, values] of source.scopes) {
    target.scopes = new Map(target.scopes).set(scope, values);
  }
}