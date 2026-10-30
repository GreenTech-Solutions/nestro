import path from 'node:path';
import { YARN_DIALECTS } from '../../shared';
import { getConfigFilePaths, readConfigFile } from './configFiles';
import { expandEnvironmentReferences, YARN_CLASSIC_ENV_SYNTAX } from '../envExpansion';
import { unwrapQuotes } from './configValues';
import { normalizeSimpleConfigKey } from './npmrc';
import { resolveCaFilePath } from './tls';

export interface ClassicYarnConfiguration {
  values: Map<string, string>;
  sourceFound: boolean;
}

/** The merged Yarn Classic `.yarnrc` files that apply to the package, user file first. */
export async function readClassicYarnConfiguration(
  packageFilePath: string | undefined,
): Promise<ClassicYarnConfiguration> {
  let values = new Map<string, string>();
  let sourceFound = false;
  for (const configPath of getConfigFilePaths(packageFilePath, YARN_DIALECTS.classic.configFile)) {
    const contents = await readConfigFile(configPath);
    if (contents !== undefined) {
      sourceFound = true;
      values = new Map([...values, ...resolveClassicCaFile(parseClassicYarnConfig(contents), path.dirname(configPath))]);
    }
  }
  return { values, sourceFound };
}

/** Parses one `.yarnrc` into the npm-style settings Yarn Classic shares; throws on an unterminated quote. */
export function parseClassicYarnConfig(contents: string): Map<string, string> {
  const config = new Map<string, string>();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.search(/\s/);
    if (separatorIndex <= 0) {
      continue;
    }
    const rawKey = line.slice(0, separatorIndex).replace(/^--/, '');
    const key = /^[A-Za-z][A-Za-z0-9-]*$/.test(rawKey)
      ? normalizeSimpleConfigKey(rawKey)
      : undefined;
    if (key === undefined) {
      continue;
    }
    const value = parseClassicYarnValue(line.slice(separatorIndex));
    if (value === undefined) {
      throw new Error('Malformed Yarn Classic configuration.');
    }
    const expanded = expandEnvironmentReferences(value, YARN_CLASSIC_ENV_SYNTAX);
    if (expanded === undefined) {
      throw new Error('Yarn Classic configuration references an unset environment variable.');
    }
    config.set(key, expanded);
  }
  return config;
}

function resolveClassicCaFile(config: Map<string, string>, baseDirectory: string): Map<string, string> {
  const cafile = config.get('cafile');
  return cafile === undefined ? config : config.set('cafile', resolveCaFilePath(cafile, baseDirectory));
}

function parseClassicYarnValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed === '' ? undefined : trimmed;
  }
  const unwrapped = unwrapQuotes(trimmed);
  if (unwrapped !== undefined) {
    return unwrapped;
  }
  return trimmed.startsWith('"') || trimmed.startsWith('\'') ? undefined : trimmed;
}