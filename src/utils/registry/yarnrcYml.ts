import { isRecord } from '../../shared';
import { parseYamlEntry, parseYamlFlowMap, parseYamlScalar, readYamlLines, skipYamlBlock } from './miniYaml';
import type { RawYamlLine } from './miniYaml';

export interface YarnScopeConfiguration {
  registryUrl: string | undefined;
  authToken: string | undefined;
  authIdent: string | undefined;
}

export interface ParsedYarnModernConfig {
  registryUrl: string | undefined;
  authToken: string | undefined;
  authIdent: string | undefined;
  httpProxy: string | undefined;
  httpsProxy: string | undefined;
  caFilePath: string | undefined;
  enableStrictSsl: boolean | undefined;
  noProxy: string | undefined;
  scopes: Map<string, YarnScopeConfiguration>;
}

/** Parses the supported keys of one `.yarnrc.yml`; undefined when the document is malformed or uses unsupported YAML. */
export function parseYarnModernConfig(contents: string): ParsedYarnModernConfig | undefined {
  const lines = readYamlLines(contents);
  if (lines === undefined) {
    return undefined;
  }
  const config: ParsedYarnModernConfig = {
    registryUrl: undefined,
    authToken: undefined,
    authIdent: undefined,
    httpProxy: undefined,
    httpsProxy: undefined,
    caFilePath: undefined,
    enableStrictSsl: undefined,
    noProxy: undefined,
    scopes: new Map(),
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.indent !== 0) {
      return undefined;
    }
    const entry = parseYamlEntry(line.content);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.key === 'npmScopes') {
      if (entry.value !== '') {
        const flow = parseYamlFlowMap(entry.value);
        if (flow === undefined || !readYarnScopes(flow, config.scopes)) {
          return undefined;
        }
        index += 1;
      }
      else {
        const parsed = readIndentedYarnScopes(lines, index + 1, config.scopes);
        if (parsed === undefined) {
          return undefined;
        }
        index = parsed;
      }
      continue;
    }

    if (isYarnModernScalarKey(entry.key)) {
      if (entry.value === '' || !readYarnModernScalar(config, entry.key, entry.value)) {
        return undefined;
      }
      index += 1;
      continue;
    }

    index = skipYamlBlock(lines, index + 1, line.indent);
  }
  return config;
}

function isYarnModernScalarKey(key: string): boolean {
  return key === 'npmRegistryServer'
    || key === 'npmAuthToken'
    || key === 'npmAuthIdent'
    || key === 'httpProxy'
    || key === 'httpsProxy'
    || key === 'caFilePath'
    || key === 'enableStrictSsl'
    || key === 'noProxy';
}

function readYarnModernScalar(
  config: ParsedYarnModernConfig,
  key: string,
  value: string,
): boolean {
  const scalar = parseYamlScalar(value);
  if (scalar === undefined) {
    return false;
  }
  if (key === 'enableStrictSsl') {
    if (typeof scalar !== 'boolean') {
      return false;
    }
    config.enableStrictSsl = scalar;
    return true;
  }
  if (typeof scalar !== 'string') {
    return false;
  }
  switch (key) {
    case 'npmRegistryServer':
      config.registryUrl = scalar;
      return true;
    case 'npmAuthToken':
      config.authToken = scalar;
      return true;
    case 'npmAuthIdent':
      config.authIdent = scalar;
      return true;
    case 'httpProxy':
      config.httpProxy = scalar;
      return true;
    case 'httpsProxy':
      config.httpsProxy = scalar;
      return true;
    case 'caFilePath':
      config.caFilePath = scalar;
      return true;
    case 'noProxy':
      config.noProxy = scalar;
      return true;
  }
  return false;
}

function readIndentedYarnScopes(
  lines: readonly RawYamlLine[],
  startIndex: number,
  scopes: Map<string, YarnScopeConfiguration>,
): number | undefined {
  if (startIndex >= lines.length || lines[startIndex].indent === 0) {
    return startIndex;
  }
  const scopeIndent = lines[startIndex].indent;
  let index = startIndex;
  while (index < lines.length && lines[index].indent > 0) {
    const line = lines[index];
    if (line.indent !== scopeIndent) {
      return undefined;
    }
    const entry = parseYamlEntry(line.content);
    if (entry === undefined || !isValidYarnScope(entry.key)) {
      return undefined;
    }
    let values: YarnScopeConfiguration | undefined;
    if (entry.value !== '') {
      const flow = parseYamlFlowMap(entry.value);
      values = flow === undefined ? undefined : readYarnScope(flow);
      index += 1;
    }
    else {
      const parsed = readIndentedYarnScopeProperties(lines, index + 1, scopeIndent);
      if (parsed === undefined) {
        return undefined;
      }
      values = parsed.values;
      index = parsed.nextIndex;
    }
    if (values === undefined) {
      return undefined;
    }
    scopes.set(normalizeYarnScope(entry.key), values);
  }
  return index;
}

function readIndentedYarnScopeProperties(
  lines: readonly RawYamlLine[],
  startIndex: number,
  scopeIndent: number,
): { values: YarnScopeConfiguration; nextIndex: number } | undefined {
  const values: YarnScopeConfiguration = {
    registryUrl: undefined,
    authToken: undefined,
    authIdent: undefined,
  };
  if (startIndex >= lines.length || lines[startIndex].indent <= scopeIndent) {
    return { values, nextIndex: startIndex };
  }
  const propertyIndent = lines[startIndex].indent;
  let index = startIndex;
  while (index < lines.length && lines[index].indent > scopeIndent) {
    const line = lines[index];
    if (line.indent !== propertyIndent) {
      return undefined;
    }
    const entry = parseYamlEntry(line.content);
    if (entry === undefined) {
      return undefined;
    }
    if (isYarnModernScopeKey(entry.key)) {
      if (entry.value === '' || !readYarnScopeScalar(values, entry.key, entry.value)) {
        return undefined;
      }
      index += 1;
    }
    else {
      index = skipYamlBlock(lines, index + 1, line.indent);
    }
  }
  return { values, nextIndex: index };
}

function readYarnScopes(
  flow: Readonly<Record<string, unknown>>,
  scopes: Map<string, YarnScopeConfiguration>,
): boolean {
  for (const [scope, value] of Object.entries(flow)) {
    if (!isValidYarnScope(scope) || !isRecord(value)) {
      return false;
    }
    const parsed = readYarnScope(value);
    if (parsed === undefined) {
      return false;
    }
    scopes.set(normalizeYarnScope(scope), parsed);
  }
  return true;
}

function readYarnScope(value: Readonly<Record<string, unknown>>): YarnScopeConfiguration | undefined {
  const scope: YarnScopeConfiguration = {
    registryUrl: undefined,
    authToken: undefined,
    authIdent: undefined,
  };
  for (const [key, entry] of Object.entries(value)) {
    if (!isYarnModernScopeKey(key)) {
      continue;
    }
    if (typeof entry !== 'string') {
      return undefined;
    }
    if (!readYarnScopeScalar(scope, key, entry)) {
      return undefined;
    }
  }
  return scope;
}

function isYarnModernScopeKey(key: string): boolean {
  return key === 'npmRegistryServer' || key === 'npmAuthToken' || key === 'npmAuthIdent';
}

function readYarnScopeScalar(scope: YarnScopeConfiguration, key: string, value: string): boolean {
  const scalar = parseYamlScalar(value);
  if (typeof scalar !== 'string') {
    return false;
  }
  switch (key) {
    case 'npmRegistryServer':
      scope.registryUrl = scalar;
      return true;
    case 'npmAuthToken':
      scope.authToken = scalar;
      return true;
    case 'npmAuthIdent':
      scope.authIdent = scalar;
      return true;
  }
  return false;
}

function isValidYarnScope(scope: string): boolean {
  const normalized = scope.startsWith('@') ? scope.slice(1) : scope;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized);
}

function normalizeYarnScope(scope: string): string {
  return scope.startsWith('@') ? scope.slice(1) : scope;
}