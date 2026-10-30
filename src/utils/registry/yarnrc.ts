import { YARN_DIALECTS } from '../../shared';
import { getConfigFilePaths, readConfigFile } from './configFiles';
import { substituteEnvironmentVariables, unwrapQuotes } from './configValues';
import { normalizeSimpleConfigKey } from './npmrc';

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
      values = new Map([...values, ...parseClassicYarnConfig(contents)]);
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
    config.set(key, substituteEnvironmentVariables(value));
  }
  return config;
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