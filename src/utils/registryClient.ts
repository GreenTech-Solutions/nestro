import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { PackageManager } from '../clients';
import { runBoundedMetadataRequest } from './metadataRunner';
import type {
  BoundedMetadataOutcome,
  MetadataOutcome,
  MetadataSchemaResult,
} from './metadataRunner';
import type { PackageMetadata, PackageMetadataOutcome } from './metadataRegistry';
import { compareRawVersions, isPreReleaseVersion } from './versionUtils';
import { resolveYarnFamily } from './yarnFamily';

const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org/';
const MAX_REGISTRY_REDIRECTS = 3;
const REGISTRY_ACCEPT_HEADER = 'application/vnd.npm.install-v1+json';
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

interface RegistryConfiguration {
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

interface RegistryRequestOptions {
  headers: Readonly<Record<string, string>>;
  ca: string | undefined;
  rejectUnauthorized: boolean | undefined;
}

interface AuthScope {
  scopeKey: string;
  origin: string;
  pathname: string;
}

interface YarnScopeConfiguration {
  registryUrl: string | undefined;
  authToken: string | undefined;
  authIdent: string | undefined;
}

interface YarnConfiguration {
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

interface YarnConfigurationWithCa extends YarnConfiguration {
  caFilePath: string;
  caFileBasePath: string;
}

interface ClassicYarnConfiguration {
  values: Map<string, string>;
  sourceFound: boolean;
}

interface ParsedYarnModernConfig {
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

interface RawYamlLine {
  indent: number;
  content: string;
}

export async function fetchPackageMetadataFromRegistry(
  packageName: string,
  packageFilePath?: string,
  signal?: AbortSignal,
  packageManager?: PackageManager,
): Promise<PackageMetadataOutcome> {
  const encodedName = encodeURIComponent(packageName).replace('%40', '@');
  let configuration: RegistryConfiguration;
  try {
    configuration = await resolveRegistryConfiguration(packageName, packageFilePath, packageManager);
  }
  catch {
    return markPrivateRegistryOutcome(
      { kind: 'unavailable', reason: 'configuration-unavailable' },
      packageManager === 'yarn' || isScopedPackageName(packageName),
    );
  }

  if (configuration.privateRegistryUnresolved) {
    return { kind: 'unavailable', reason: 'configuration-unavailable', privateRegistry: true };
  }

  let url: string;
  try {
    url = buildRegistryPackageUrl(configuration.registryUrl, encodedName);
  }
  catch {
    return markPrivateRegistryOutcome(
      { kind: 'unavailable', reason: 'configuration-unavailable' },
      configuration.registryConfigured,
    );
  }

  if (configuration.proxyConfigured && !isNoProxyHost(new URL(url).hostname, configuration.noProxy)) {
    return markPrivateRegistryOutcome(
      { kind: 'transport-error', reason: 'proxy-unsupported' },
      configuration.registryConfigured,
    );
  }

  const authorization = getAuthorizationHeader(
    url,
    configuration.values,
    configuration.authToken,
    configuration.authIdent,
    configuration.authRegistryUrl,
  );
  const headers: Record<string, string> = { Accept: REGISTRY_ACCEPT_HEADER };
  if (authorization !== undefined) {
    headers.Authorization = authorization;
  }
  return markPrivateRegistryOutcome(withoutTransportMessage(await requestRegistryPayload(
    url,
    parseNpmRegistryMetadata,
    packageName,
    { headers, ca: configuration.ca, rejectUnauthorized: configuration.rejectUnauthorized },
    signal,
  )), configuration.registryConfigured);
}

async function requestRegistryPayload<T>(
  url: string,
  parse: (payload: unknown) => MetadataSchemaResult<T>,
  packageName: string,
  options: RegistryRequestOptions,
  signal?: AbortSignal,
): Promise<BoundedMetadataOutcome<T>> {
  let requestUrl = url;
  let headers = options.headers;

  for (let redirectCount = 0; ; redirectCount += 1) {
    const outcome = await runBoundedMetadataRequest(requestUrl, {
      parse,
      signal,
      headers,
      ca: options.ca,
      rejectUnauthorized: options.rejectUnauthorized,
      timeoutErrorMessage: `npm registry request timed out after 15000ms for ${packageName}`,
      overflowErrorMessage: `npm registry response exceeded 5242880 bytes for ${packageName}`,
    });
    const location = getRedirectLocation(outcome);
    if (location === undefined) {
      return outcome;
    }
    if (redirectCount >= MAX_REGISTRY_REDIRECTS) {
      return { kind: 'transport-error', reason: 'request' };
    }

    const redirectedUrl = resolveRedirectUrl(requestUrl, location);
    if (redirectedUrl === undefined) {
      return { kind: 'transport-error', reason: 'request' };
    }
    if (!sameOrigin(requestUrl, redirectedUrl)) {
      headers = withoutAuthorization(headers);
    }
    requestUrl = redirectedUrl;
  }
}

function getRedirectLocation<T>(outcome: BoundedMetadataOutcome<T>): string | undefined {
  if (outcome.kind !== 'transport-error'
    || outcome.statusCode === undefined
    || outcome.statusCode < 300
    || outcome.statusCode >= 400) {
    return undefined;
  }
  return outcome.redirectLocation;
}

function resolveRedirectUrl(currentUrl: string, location: string): string | undefined {
  try {
    const redirected = new URL(location, currentUrl);
    if (redirected.protocol !== 'https:' || redirected.username !== '' || redirected.password !== '') {
      return undefined;
    }
    return redirected.toString();
  }
  catch {
    return undefined;
  }
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  }
  catch {
    return false;
  }
}

function withoutAuthorization(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const safeHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'authorization') {
      safeHeaders[name] = value;
    }
  }
  return safeHeaders;
}

export function parseNpmRegistryMetadata(json: unknown): MetadataSchemaResult<PackageMetadata> {
  if (!isRecord(json)) {
    return { kind: 'unrecognized' };
  }
  if (!Object.hasOwn(json, 'dist-tags') || !Object.hasOwn(json, 'versions')) {
    return { kind: 'unrecognized' };
  }

  const distTags = readStringMap(json['dist-tags']);
  const versions = isRecord(json.versions) ? Object.keys(json.versions).reverse() : undefined;
  if (distTags === undefined || versions === undefined) {
    return { kind: 'malformed' };
  }

  const publishTimes = parsePublishTimes(json.time, versions);
  return {
    kind: 'recognized',
    result: { distTags, versions, publishTimes },
  };
}

function parsePublishTimes(
  value: unknown,
  versions: readonly string[],
): PackageMetadata['publishTimes'] {
  if (!isRecord(value)) {
    return { kind: 'not-provided' };
  }

  const versionSet = new Set(versions);
  return {
    kind: 'provided',
    byVersion: Object.fromEntries(
      Object.entries(value).filter(([version, publishTime]) => (
        versionSet.has(version) && typeof publishTime === 'string'
      )),
    ) as Record<string, string>,
  };
}

function readStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value);
  if (entries.some(([, entry]) => typeof entry !== 'string')) {
    return undefined;
  }

  return Object.fromEntries(entries) as Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withoutTransportMessage<T>(outcome: BoundedMetadataOutcome<T>): MetadataOutcome<T> {
  if (outcome.kind !== 'transport-error') {
    return outcome;
  }
  if (outcome.statusCode === undefined) {
    return { kind: 'transport-error', reason: outcome.reason };
  }
  return { kind: 'transport-error', reason: outcome.reason, statusCode: outcome.statusCode };
}

async function resolveRegistryConfiguration(
  packageName: string,
  packageFilePath: string | undefined,
  packageManager: PackageManager | undefined,
): Promise<RegistryConfiguration> {
  const npmrcValues = await readNpmrcConfig(packageFilePath);
  let values = npmrcValues;
  let yarnConfiguration: YarnConfiguration | undefined;
  if (packageManager === 'yarn') {
    const packageRoot = getPackageRoot(packageFilePath);
    const family = packageRoot === undefined
      ? { family: 'unknown' as const, source: 'version-probe' as const }
      : await resolveYarnFamily(packageRoot);
    if (family.source === 'conflicting-markers') {
      throw new Error('Yarn family is ambiguous.');
    }
    if (family.family === 'modern') {
      yarnConfiguration = await readYarnModernConfiguration(packageFilePath);
      values = new Map();
    }
    else if (family.family === 'classic') {
      mergeClassicYarnConfig(values, (await readClassicYarnConfiguration(packageFilePath)).values);
    }
    else {
      const [modernConfiguration, classicConfiguration] = await Promise.all([
        readYarnModernConfiguration(packageFilePath),
        readClassicYarnConfiguration(packageFilePath),
      ]);
      if (modernConfiguration.sourceFound && classicConfiguration.sourceFound) {
        throw new Error('Yarn family is ambiguous.');
      }
      if (modernConfiguration.sourceFound) {
        yarnConfiguration = modernConfiguration;
        values = new Map();
      }
      else if (classicConfiguration.sourceFound) {
        mergeClassicYarnConfig(values, classicConfiguration.values);
      }
    }
  }

  const yarnScope = yarnConfiguration === undefined
    ? undefined
    : getYarnScopeConfiguration(packageName, yarnConfiguration.scopes);
  const scopedRegistry = yarnScope?.registryUrl ?? yarnConfiguration?.registryUrl ?? getScopedRegistry(packageName, values);
  const configuredRegistry = scopedRegistry ?? values.get('registry');
  const registryUrl = configuredRegistry ?? DEFAULT_REGISTRY_URL;
  const privateRegistryUnresolved = packageManager === 'yarn'
    && yarnConfiguration !== undefined
    && getScopedRegistry(packageName, npmrcValues) !== undefined
    && yarnScope?.registryUrl === undefined;
  const httpsProxy = yarnConfiguration?.httpsProxy ?? values.get('https-proxy');
  const proxy = yarnConfiguration === undefined
    ? (httpsProxy === undefined ? values.get('proxy') : httpsProxy)
    : (httpsProxy ?? yarnConfiguration.httpProxy);
  const ca = yarnConfiguration !== undefined && isYarnConfigurationWithCa(yarnConfiguration)
    ? await resolveYarnCa(yarnConfiguration)
    : await resolveCa(values);
  const authToken = yarnScope?.authToken ?? yarnConfiguration?.authToken;
  const authIdent = yarnScope?.authIdent ?? yarnConfiguration?.authIdent;
  const authRegistryUrl = yarnConfiguration === undefined
    ? undefined
    : getYarnAuthRegistryUrl(yarnConfiguration, yarnScope);
  return {
    registryUrl,
    registryConfigured: configuredRegistry !== undefined,
    privateRegistryUnresolved,
    values,
    proxyConfigured: proxy !== undefined && proxy.trim() !== '',
    noProxy: getNoProxyConfiguration(values, yarnConfiguration?.noProxy),
    ca,
    rejectUnauthorized: yarnConfiguration?.enableStrictSsl
      ?? parseStrictSsl(values.get('strict-ssl')),
    authToken,
    authIdent,
    authRegistryUrl,
  };
}

function getYarnAuthRegistryUrl(
  config: YarnConfiguration,
  scope: YarnScopeConfiguration | undefined,
): string {
  const scopeAuthConfigured = scope?.authToken !== undefined || scope?.authIdent !== undefined;
  return scopeAuthConfigured
    ? scope.registryUrl ?? config.registryUrl ?? DEFAULT_REGISTRY_URL
    : config.registryUrl ?? DEFAULT_REGISTRY_URL;
}

function getNoProxyConfiguration(
  config: ReadonlyMap<string, string>,
  yarnNoProxy: string | undefined,
): string | undefined {
  const values = [yarnNoProxy, config.get('no-proxy'), process.env.NO_PROXY, process.env.no_proxy]
    .filter((value): value is string => value !== undefined && value.trim() !== '');
  return values.length === 0 ? undefined : values.join(',');
}

function getYarnScopeConfiguration(
  packageName: string,
  scopes: ReadonlyMap<string, YarnScopeConfiguration>,
): YarnScopeConfiguration | undefined {
  if (!packageName.startsWith('@')) {
    return undefined;
  }
  const scopeEndIndex = packageName.indexOf('/');
  if (scopeEndIndex <= 1) {
    return undefined;
  }
  return scopes.get(packageName.slice(1, scopeEndIndex));
}

function isNoProxyHost(hostname: string, noProxy: string | undefined): boolean {
  if (noProxy === undefined) {
    return false;
  }

  const normalizedHostname = hostname.toLowerCase().replace(/\.$/, '');
  return noProxy.split(',').some((rawEntry) => {
    const entry = rawEntry.trim().toLowerCase().replace(/\.$/, '');
    if (entry === '*') {
      return true;
    }
    if (entry.startsWith('.')) {
      const suffix = entry.slice(1);
      return normalizedHostname === suffix || normalizedHostname.endsWith(entry);
    }
    return normalizedHostname === entry;
  });
}

async function readNpmrcConfig(packageFilePath: string | undefined): Promise<Map<string, string>> {
  const config = new Map<string, string>();
  for (const npmrcPath of getNpmrcPaths(packageFilePath)) {
    mergeNpmrcConfig(config, await readNpmrcFile(npmrcPath));
  }
  applyEnvironmentOverrides(config);
  return config;
}

function getNpmrcPaths(packageFilePath: string | undefined): string[] {
  return [path.join(homedir(), '.npmrc'), ...getProjectConfigPaths(packageFilePath, '.npmrc')];
}

function getProjectConfigPaths(packageFilePath: string | undefined, fileName: string): string[] {
  const workspaceRoot = packageFilePath === undefined
    ? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    : vscode.workspace.getWorkspaceFolder(vscode.Uri.file(packageFilePath))?.uri.fsPath;
  if (workspaceRoot === undefined) {
    return [];
  }

  const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
  const packageRoot = packageFilePath === undefined
    ? normalizedWorkspaceRoot
    : path.resolve(path.dirname(packageFilePath));
  if (!isPathContained(normalizedWorkspaceRoot, packageRoot)) {
    return [path.join(normalizedWorkspaceRoot, fileName)];
  }

  const projectDirectories: string[] = [];
  let current = packageRoot;
  while (isPathContained(normalizedWorkspaceRoot, current)) {
    projectDirectories.unshift(current);
    if (current === normalizedWorkspaceRoot) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return [...new Set(projectDirectories.map(directory => path.join(directory, fileName)))];
}

function isPathContained(basePath: string, candidatePath: string): boolean {
  const relative = path.relative(basePath, candidatePath);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function readNpmrcFile(npmrcPath: string): Promise<string> {
  return await readOptionalFile(npmrcPath) ?? '';
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  }
  catch {
    return undefined;
  }
}

function getPackageRoot(packageFilePath: string | undefined): string | undefined {
  if (packageFilePath !== undefined) {
    return path.resolve(path.dirname(packageFilePath));
  }
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return workspaceRoot === undefined ? undefined : path.resolve(workspaceRoot);
}

async function readClassicYarnConfiguration(
  packageFilePath: string | undefined,
): Promise<ClassicYarnConfiguration> {
  const config = new Map<string, string>();
  let sourceFound = false;
  for (const configPath of getYarnConfigPaths(packageFilePath, '.yarnrc')) {
    const contents = await readOptionalFile(configPath);
    if (contents !== undefined) {
      sourceFound = true;
      mergeClassicYarnConfig(config, parseClassicYarnConfig(contents));
    }
  }
  return { values: config, sourceFound };
}

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
      ? normalizeClassicYarnConfigKey(rawKey)
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

function normalizeClassicYarnConfigKey(key: string): string | undefined {
  const normalized = key.toLowerCase();
  if (normalized === 'registry'
    || normalized === 'proxy'
    || normalized === 'https-proxy'
    || normalized === 'ca'
    || normalized === 'cafile'
    || normalized === 'strict-ssl'
    || normalized === 'no-proxy') {
    return normalized;
  }
  return undefined;
}

function parseClassicYarnValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed === '' ? undefined : trimmed;
  }
  const first = trimmed[0];
  const last = trimmed.at(-1);
  if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
    return trimmed.slice(1, -1);
  }
  if (first === '"' || first === '\'') {
    return undefined;
  }
  return trimmed;
}

function mergeClassicYarnConfig(config: Map<string, string>, values: ReadonlyMap<string, string>): void {
  for (const [key, value] of values) {
    config.set(key, value);
  }
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
  for (const configPath of getYarnConfigPaths(packageFilePath, '.yarnrc.yml')) {
    const contents = await readOptionalFile(configPath);
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

function getYarnConfigPaths(packageFilePath: string | undefined, fileName: string): string[] {
  return [...new Set([
    path.join(homedir(), fileName),
    ...getProjectConfigPaths(packageFilePath, fileName),
  ])];
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

function readYamlLines(contents: string): RawYamlLine[] | undefined {
  const lines: RawYamlLine[] = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    if (rawLine.trim() === '' || rawLine.trimStart().startsWith('#')) {
      continue;
    }
    const match = /^( *)\S/.exec(rawLine);
    if (match === null || rawLine.slice(0, match[1].length).includes('\t')) {
      return undefined;
    }
    const content = stripYamlComment(rawLine.slice(match[1].length));
    if (content.trim() !== '') {
      lines.push({ indent: match[1].length, content });
    }
  }
  return lines;
}

function stripYamlComment(value: string): string {
  let quote: '"' | '\'' | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === quote) {
      quote = undefined;
    }
    else if ((character === '"' || character === '\'') && quote === undefined) {
      quote = character;
    }
    else if (character === '#' && quote === undefined
      && (index === 0 || /\s/.test(value[index - 1] ?? ''))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
}

function parseYamlEntry(content: string): { key: string; value: string } | undefined {
  const separatorIndex = content.indexOf(':');
  if (separatorIndex <= 0) {
    return undefined;
  }
  const key = content.slice(0, separatorIndex).trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) {
    return undefined;
  }
  return { key, value: content.slice(separatorIndex + 1).trim() };
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

function skipYamlBlock(lines: readonly RawYamlLine[], startIndex: number, parentIndent: number): number {
  let index = startIndex;
  while (index < lines.length && lines[index].indent > parentIndent) {
    index += 1;
  }
  return index;
}

function parseYamlScalar(value: string): string | boolean | undefined {
  const trimmed = value.trim();
  if (trimmed === 'true') {
    return true;
  }
  if (trimmed === 'false') {
    return false;
  }
  if (trimmed === '' || trimmed === 'null' || trimmed === '~'
    || trimmed.startsWith('[') || trimmed.startsWith('{') || trimmed.startsWith('&')
    || trimmed.startsWith('*') || trimmed.startsWith('|') || trimmed.startsWith('>')) {
    return undefined;
  }
  const first = trimmed[0];
  const last = trimmed.at(-1);
  if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
    return substituteEnvironmentVariables(trimmed.slice(1, -1));
  }
  if (first === '"' || first === '\'' || trimmed.includes(' {')) {
    return undefined;
  }
  return substituteEnvironmentVariables(trimmed);
}

function parseYamlFlowMap(value: string): Record<string, unknown> | undefined {
  let index = 0;
  const parsed = readYamlFlowMap(value, index);
  if (parsed === undefined) {
    return undefined;
  }
  index = skipYamlWhitespace(value, parsed.nextIndex);
  return index === value.length ? parsed.value : undefined;
}

function readYamlFlowMap(
  value: string,
  startIndex: number,
): { value: Record<string, unknown>; nextIndex: number } | undefined {
  let index = skipYamlWhitespace(value, startIndex);
  if (value[index] !== '{') {
    return undefined;
  }
  index = skipYamlWhitespace(value, index + 1);
  const result: Record<string, unknown> = {};
  if (value[index] === '}') {
    return { value: result, nextIndex: index + 1 };
  }
  while (index < value.length) {
    const keyStart = index;
    while (index < value.length && /[A-Za-z0-9_@.-]/.test(value[index] ?? '')) {
      index += 1;
    }
    const key = value.slice(keyStart, index);
    if (key === '' || Object.hasOwn(result, key)) {
      return undefined;
    }
    index = skipYamlWhitespace(value, index);
    if (value[index] !== ':') {
      return undefined;
    }
    const parsedValue = readYamlFlowValue(value, index + 1);
    if (parsedValue === undefined) {
      return undefined;
    }
    result[key] = parsedValue.value;
    index = skipYamlWhitespace(value, parsedValue.nextIndex);
    if (value[index] === '}') {
      return { value: result, nextIndex: index + 1 };
    }
    if (value[index] !== ',') {
      return undefined;
    }
    index = skipYamlWhitespace(value, index + 1);
  }
  return undefined;
}

function readYamlFlowValue(
  value: string,
  startIndex: number,
): { value: unknown; nextIndex: number } | undefined {
  const index = skipYamlWhitespace(value, startIndex);
  if (value[index] === '{') {
    return readYamlFlowMap(value, index);
  }
  const first = value[index];
  if (first === '"' || first === '\'') {
    let end = index + 1;
    while (end < value.length && value[end] !== first) {
      end += 1;
    }
    if (end >= value.length) {
      return undefined;
    }
    return {
      value: substituteEnvironmentVariables(value.slice(index + 1, end)),
      nextIndex: end + 1,
    };
  }
  let end = index;
  while (end < value.length && value[end] !== ',' && value[end] !== '}') {
    end += 1;
  }
  const scalar = parseYamlScalar(value.slice(index, end));
  return scalar === undefined ? undefined : { value: scalar, nextIndex: end };
}

function skipYamlWhitespace(value: string, startIndex: number): number {
  let index = startIndex;
  while (index < value.length && /\s/.test(value[index] ?? '')) {
    index += 1;
  }
  return index;
}

async function resolveYarnCa(config: YarnConfigurationWithCa): Promise<string> {
  return normalizeCa(await readFile(path.resolve(config.caFileBasePath, config.caFilePath), 'utf8'));
}

function isYarnConfigurationWithCa(config: YarnConfiguration): config is YarnConfigurationWithCa {
  return config.caFilePath !== undefined && config.caFileBasePath !== undefined;
}

async function resolveCa(config: ReadonlyMap<string, string>): Promise<string | undefined> {
  const configuredCa = config.get('ca');
  if (configuredCa !== undefined && configuredCa !== '') {
    return normalizeCa(configuredCa);
  }

  const cafile = config.get('cafile');
  if (cafile === undefined || cafile === '') {
    return undefined;
  }
  return normalizeCa(await readFile(path.resolve(cafile), 'utf8'));
}

function normalizeCa(value: string): string {
  return value.replaceAll('\\n', '\n');
}

function mergeNpmrcConfig(config: Map<string, string>, npmrc: string): void {
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
    const value = stripNpmrcQuotes(line.slice(separatorIndex + 1).trim());
    config.set(key, substituteEnvironmentVariables(value));
  }
}

function applyEnvironmentOverrides(config: Map<string, string>): void {
  for (const [environmentKey, environmentValue] of Object.entries(process.env)) {
    if (!environmentKey.toLowerCase().startsWith('npm_config_') || environmentValue === undefined) {
      continue;
    }
    const key = normalizeConfigKey(environmentKey.slice('npm_config_'.length));
    if (key !== undefined) {
      config.set(key, substituteEnvironmentVariables(environmentValue));
    }
  }
}

function normalizeConfigKey(key: string): string | undefined {
  const lowerKey = key.toLowerCase();
  const dashedKey = lowerKey.replaceAll('_', '-');
  if (SIMPLE_CONFIG_KEYS.has(dashedKey)) {
    return dashedKey;
  }
  if (/^@[^:]+:registry$/i.test(key)) {
    const separatorIndex = key.indexOf(':');
    return `${key.slice(0, separatorIndex)}:registry`;
  }

  const auth = parseAuthConfigKey(key);
  return auth === undefined ? undefined : `${auth.scopeKey}:${auth.property}`;
}

function parseAuthConfigKey(key: string): (AuthScope & { property: string }) | undefined {
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

function substituteEnvironmentVariables(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, variable: string) => (
    process.env[variable] ?? ''
  ));
}

function stripNpmrcQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith('\'') && value.endsWith('\''))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function getScopedRegistry(packageName: string, config: ReadonlyMap<string, string>): string | undefined {
  if (!packageName.startsWith('@')) {
    return undefined;
  }
  const scopeEndIndex = packageName.indexOf('/');
  if (scopeEndIndex === -1) {
    return undefined;
  }
  return config.get(`${packageName.slice(0, scopeEndIndex)}:registry`);
}

function buildRegistryPackageUrl(registryUrl: string, encodedName: string): string {
  const registry = new URL(registryUrl);
  if (registry.protocol !== 'https:') {
    throw new Error('Registry URL must use HTTPS.');
  }
  registry.username = '';
  registry.password = '';
  const registryString = registry.toString();
  const baseUrl = registryString.endsWith('/') ? registryString : `${registryString}/`;
  return new URL(encodedName, baseUrl).toString();
}

function getAuthorizationHeader(
  requestUrl: string,
  config: ReadonlyMap<string, string>,
  authToken: string | undefined,
  authIdent: string | undefined,
  authRegistryUrl: string | undefined,
): string | undefined {
  const request = new URL(requestUrl);
  const scopes = new Map<string, AuthScope>();
  for (const key of config.keys()) {
    const auth = parseAuthConfigKey(key);
    if (auth !== undefined && auth.origin === request.origin && request.pathname.startsWith(auth.pathname)) {
      scopes.set(auth.scopeKey, auth);
    }
  }

  const orderedScopes = [...scopes.values()].sort((left, right) => right.pathname.length - left.pathname.length);
  for (const scope of orderedScopes) {
    const token = config.get(`${scope.scopeKey}:_authToken`);
    if (token !== undefined && token !== '') {
      return `Bearer ${token}`;
    }

    const auth = config.get(`${scope.scopeKey}:_auth`);
    if (auth !== undefined && auth !== '') {
      return `Basic ${auth}`;
    }

    const username = config.get(`${scope.scopeKey}:username`);
    const password = config.get(`${scope.scopeKey}:_password`);
    if (username !== undefined && password !== undefined) {
      const decodedPassword = Buffer.from(password, 'base64').toString('utf8');
      return `Basic ${Buffer.from(`${username}:${decodedPassword}`).toString('base64')}`;
    }
  }
  if (authToken !== undefined && authToken !== ''
    && authRegistryUrl !== undefined && isWithinRegistryPath(request, authRegistryUrl)) {
    return `Bearer ${authToken}`;
  }
  if (authIdent !== undefined && authIdent !== ''
    && authRegistryUrl !== undefined && isWithinRegistryPath(request, authRegistryUrl)) {
    return `Basic ${encodeYarnAuthIdent(authIdent)}`;
  }
  return undefined;
}

function isWithinRegistryPath(request: URL, registryUrl: string): boolean {
  try {
    const registry = new URL(registryUrl);
    const registryPath = registry.pathname.endsWith('/') ? registry.pathname : `${registry.pathname}/`;
    return request.origin === registry.origin && request.pathname.startsWith(registryPath);
  }
  catch {
    return false;
  }
}

function encodeYarnAuthIdent(value: string): string {
  return value.includes(':') ? Buffer.from(value).toString('base64') : value;
}

function parseStrictSsl(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.toLowerCase() === 'false' || value === '0') {
    return false;
  }
  if (value.toLowerCase() === 'true' || value === '1') {
    return true;
  }
  return undefined;
}

function markPrivateRegistryOutcome(
  outcome: PackageMetadataOutcome,
  privateRegistry: boolean,
): PackageMetadataOutcome {
  if (!privateRegistry || outcome.kind === 'success' || outcome.kind === 'aborted') {
    return outcome;
  }
  return { ...outcome, privateRegistry: true };
}

function isScopedPackageName(packageName: string): boolean {
  return packageName.startsWith('@') && packageName.includes('/');
}

export function selectVersionsForPicker(
  allVersions: readonly string[],
  _tags: Record<string, string>,
  currentVersion: string,
  includePreReleases: boolean,
): string[] {
  const normalizedCurrent = currentVersion.replace(/^workspace:/, '').replace(/^([~^]|>=|>|<=|<)/, '');
  const selected = new Set([normalizedCurrent]);

  return allVersions
    .filter(version => (
      includePreReleases
      || !isPreReleaseVersion(version)
      || selected.has(version)
    ))
    .sort((left, right) => -compareRawVersions(left, right));
}