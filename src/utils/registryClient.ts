import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { runBoundedMetadataRequest } from './metadataRunner';
import type { BoundedMetadataOutcome, MetadataOutcome, MetadataSchemaResult } from './metadataRunner';
import type { PackageMetadata, PackageMetadataOutcome } from './metadataRegistry';
import { compareRawVersions, isPreReleaseVersion } from './versionUtils';

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
  values: ReadonlyMap<string, string>;
  proxyConfigured: boolean;
  noProxy: string | undefined;
  ca: string | undefined;
  rejectUnauthorized: boolean | undefined;
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

export async function fetchPackageMetadataFromRegistry(
  packageName: string,
  packageFilePath?: string,
  signal?: AbortSignal,
): Promise<PackageMetadataOutcome> {
  const encodedName = encodeURIComponent(packageName).replace('%40', '@');
  let configuration: RegistryConfiguration;
  let url: string;
  try {
    configuration = await resolveRegistryConfiguration(packageName, packageFilePath);
    url = buildRegistryPackageUrl(configuration.registryUrl, encodedName);
  }
  catch {
    return { kind: 'unavailable', reason: 'configuration-unavailable' };
  }

  if (configuration.proxyConfigured && !isNoProxyHost(new URL(url).hostname, configuration.noProxy)) {
    return { kind: 'transport-error', reason: 'proxy-unsupported' };
  }

  const authorization = getAuthorizationHeader(url, configuration.values);
  const headers: Record<string, string> = { Accept: REGISTRY_ACCEPT_HEADER };
  if (authorization !== undefined) {
    headers.Authorization = authorization;
  }
  return withoutTransportMessage(await requestRegistryPayload(
    url,
    parseNpmRegistryMetadata,
    packageName,
    { headers, ca: configuration.ca, rejectUnauthorized: configuration.rejectUnauthorized },
    signal,
  ));
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
): Promise<RegistryConfiguration> {
  const values = await readNpmrcConfig(packageFilePath);
  const registryUrl = getScopedRegistry(packageName, values) ?? values.get('registry') ?? DEFAULT_REGISTRY_URL;
  const httpsProxy = values.get('https-proxy');
  const proxy = httpsProxy === undefined ? values.get('proxy') : httpsProxy;
  const ca = await resolveCa(values);
  return {
    registryUrl,
    values,
    proxyConfigured: proxy !== undefined && proxy.trim() !== '',
    noProxy: getNoProxyConfiguration(values),
    ca,
    rejectUnauthorized: parseStrictSsl(values.get('strict-ssl')),
  };
}

function getNoProxyConfiguration(config: ReadonlyMap<string, string>): string | undefined {
  const values = [config.get('no-proxy'), process.env.NO_PROXY, process.env.no_proxy]
    .filter((value): value is string => value !== undefined && value.trim() !== '');
  return values.length === 0 ? undefined : values.join(',');
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
  const paths = [path.join(homedir(), '.npmrc')];
  const workspaceRoot = packageFilePath === undefined
    ? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    : vscode.workspace.getWorkspaceFolder(vscode.Uri.file(packageFilePath))?.uri.fsPath;
  if (workspaceRoot === undefined) {
    return paths;
  }

  const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
  const packageRoot = packageFilePath === undefined
    ? normalizedWorkspaceRoot
    : path.resolve(path.dirname(packageFilePath));
  if (!isPathContained(normalizedWorkspaceRoot, packageRoot)) {
    paths.push(path.join(normalizedWorkspaceRoot, '.npmrc'));
    return paths;
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
  paths.push(...projectDirectories.map(directory => path.join(directory, '.npmrc')));
  return [...new Set(paths)];
}

function isPathContained(basePath: string, candidatePath: string): boolean {
  const relative = path.relative(basePath, candidatePath);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function readNpmrcFile(npmrcPath: string): Promise<string> {
  try {
    return await readFile(npmrcPath, 'utf8');
  }
  catch {
    return '';
  }
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
  return undefined;
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