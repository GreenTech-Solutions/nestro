import { formatDependencySpec, parseDependencySpec } from './dependencySpec';

export type DependencySection = 'dependencies' | 'devDependencies';

export interface PackageVersionUpdate {
  name: string;
  version: string;
  section: DependencySection;
}

export interface PackageFileDependencyUpdates {
  packageFilePath: string;
  updates: readonly PackageVersionUpdate[];
}

export interface PackageJsonDocument {
  [key: string]: unknown;
}

export interface PreparedPinAllVersions {
  readonly updated: string | undefined;
  readonly count: number;
}

export class VersionPinConflictError extends Error {
  constructor() {
    super('Package action is no longer available. Refresh the package list and try again.');
    this.name = 'VersionPinConflictError';
  }
}

export class DependencyTypeConflictError extends Error {
  readonly expectedSourceSpec: unknown;
  readonly actualSourceSpec: unknown;
  readonly targetSpec: unknown;
  readonly hasTargetSpec: boolean;

  constructor(
    packageName: unknown,
    expectedSourceSpec: unknown,
    actualSourceSpec: unknown,
    targetSpec?: unknown,
  ) {
    const hasTargetSpec = arguments.length >= 4;
    const safePackageName = sanitizeConflictText(packageName);
    const safeExpectedSourceSpec = sanitizeConflictText(expectedSourceSpec);
    const safeActualSourceSpec = sanitizeConflictText(actualSourceSpec);
    const message = !hasTargetSpec
      ? `Cannot switch ${safePackageName}: source spec changed from ${safeExpectedSourceSpec} to ${safeActualSourceSpec}.`
      : `Cannot switch ${safePackageName}: source spec ${safeActualSourceSpec} conflicts with target spec ${sanitizeConflictText(targetSpec)}.`;
    super(message);
    this.name = 'DependencyTypeConflictError';
    this.expectedSourceSpec = expectedSourceSpec;
    this.actualSourceSpec = actualSourceSpec;
    this.targetSpec = targetSpec;
    this.hasTargetSpec = hasTargetSpec;
  }
}

export function parsePackageJson(raw: string): PackageJsonDocument {
  return JSON.parse(raw) as PackageJsonDocument;
}

export function extractVersionPrefix(versionString: string): string {
  if (versionString.startsWith('workspace:')) {
    return '';
  }

  const match = /^([~^]|>=|>|<=|<)/.exec(versionString);
  return match?.[1] ?? '';
}

export function serializePackageJson(raw: string, json: PackageJsonDocument): string {
  const indent = detectJsonIndent(raw);
  const newlineStyle = detectNewlineStyle(raw);
  const trailingNewline = raw.endsWith('\r\n')
    ? '\r\n'
    : raw.endsWith('\n') ? '\n' : raw.endsWith('\r') ? '\r' : '';
  const serialized = JSON.stringify(json, undefined, indent).replace(/\n/g, newlineStyle);
  return `${serialized}${trailingNewline}`;
}

export function transformDependencyVersions(
  json: PackageJsonDocument,
  updates: readonly PackageVersionUpdate[],
): PackageJsonDocument {
  const transformed = cloneDependencySections(json);
  const missing: string[] = [];

  for (const update of updates) {
    const dependencies = transformed[update.section];
    const current = readDependencyValue(dependencies, update.name);
    if (current !== undefined) {
      setDependencyValue(
        transformed,
        update.section,
        update.name,
        `${extractVersionPrefix(current as string)}${update.version}`,
      );
      continue;
    }
    missing.push(`${update.name} (${update.section})`);
  }

  if (missing.length > 0) {
    throw new Error(`Package(s) not found in package.json: ${missing.join(', ')}`);
  }

  return transformed;
}

export function transformDependencyType(
  json: PackageJsonDocument,
  packageName: string,
  currentlyDev: boolean,
  expectedSourceSpec: string,
): PackageJsonDocument {
  const runtimeJson = cloneDependencySections(json);
  const sourceKey = currentlyDev ? 'devDependencies' : 'dependencies';
  const targetKey = currentlyDev ? 'dependencies' : 'devDependencies';
  const sourceEntry = readOwnDependencySpec(runtimeJson[sourceKey], packageName);
  if (!sourceEntry.valid || !sourceEntry.present) {
    throw new DependencyTypeConflictError(packageName, expectedSourceSpec, sourceEntry.value);
  }
  const version = sourceEntry.value;
  if (version !== expectedSourceSpec) {
    throw new DependencyTypeConflictError(packageName, expectedSourceSpec, version);
  }

  const targetEntry = readOwnDependencySpec(runtimeJson[targetKey], packageName);
  if (!targetEntry.valid || targetEntry.present) {
    throw new DependencyTypeConflictError(packageName, expectedSourceSpec, version, targetEntry.value);
  }

  const source = sourceEntry.section;
  if (source === undefined) {
    throw new DependencyTypeConflictError(packageName, expectedSourceSpec, version);
  }
  delete source[packageName];
  if (Object.keys(source).length === 0) {
    delete runtimeJson[sourceKey];
  }
  else {
    runtimeJson[sourceKey] = source;
  }

  runtimeJson[targetKey] = sortDependencyMap({
    ...(targetEntry.section ?? {}),
    [packageName]: version,
  });

  return runtimeJson;
}

export function transformVersionPin(
  json: PackageJsonDocument,
  packageName: string,
  section: DependencySection,
  expectedSpec: string,
  pin: boolean,
): PackageJsonDocument {
  const transformed = cloneDependencySections(json);
  const current = readDependencyValue(transformed[section], packageName);
  if (current !== expectedSpec) {
    throw new VersionPinConflictError();
  }
  const parsed = parseDependencySpec(current);
  if (!parsed.supported) {
    throw new Error(`Cannot toggle pin for ${packageName}: ${parsed.reason}.`);
  }
  transformed[section] = {
    ...(isRecord(transformed[section]) ? transformed[section] : {}),
    [packageName]: formatDependencySpec(parsed, pin),
  };
  return transformed;
}

export function transformPinAllVersions(json: PackageJsonDocument): { json: PackageJsonDocument; count: number } {
  const transformed = cloneDependencySections(json);
  let count = 0;
  for (const section of ['dependencies', 'devDependencies'] as const) {
    const dependencies = transformed[section];
    // A section can be JSON `null` in a hand-edited file; treat it the same as absent.
    if (dependencies === undefined || dependencies === null) { continue; }
    for (const [name, version] of Object.entries(dependencies as Record<string, unknown>)) {
      const parsed = parseDependencySpec(version as string);
      if (parsed.supported && parsed.range !== 'exact') {
        (dependencies as Record<string, unknown>)[name] = formatDependencySpec(parsed, true);
        count++;
      }
    }
  }
  return { json: transformed, count };
}

export function prepareDependencyVersions(raw: string, updates: readonly PackageVersionUpdate[]): string {
  return serializePackageJson(raw, transformDependencyVersions(parsePackageJson(raw), updates));
}

export function prepareDependencyType(
  raw: string,
  packageName: string,
  currentlyDev: boolean,
  expectedSourceSpec: string,
): string {
  return serializePackageJson(
    raw,
    transformDependencyType(parsePackageJson(raw), packageName, currentlyDev, expectedSourceSpec),
  );
}

export function prepareVersionPin(
  raw: string,
  packageName: string,
  section: DependencySection,
  expectedSpec: string,
  pin: boolean,
): string {
  return serializePackageJson(
    raw,
    transformVersionPin(parsePackageJson(raw), packageName, section, expectedSpec, pin),
  );
}

export function preparePinAllVersions(raw: string): PreparedPinAllVersions {
  const result = transformPinAllVersions(parsePackageJson(raw));
  return {
    updated: result.count === 0 ? undefined : serializePackageJson(raw, result.json),
    count: result.count,
  };
}

function cloneDependencySections(json: PackageJsonDocument): PackageJsonDocument {
  const transformed = { ...json };
  for (const section of ['dependencies', 'devDependencies'] as const) {
    const dependencies = transformed[section];
    if (isRecord(dependencies)) {
      transformed[section] = { ...dependencies };
    }
    else if (Array.isArray(dependencies)) {
      transformed[section] = [...dependencies];
    }
  }
  return transformed;
}

function readDependencyValue(section: unknown, packageName: string): unknown {
  if (section === undefined || section === null) {
    return undefined;
  }
  if (typeof section !== 'object' && typeof section !== 'function' && typeof section !== 'string') {
    return undefined;
  }
  return (section as Record<string, unknown>)[packageName];
}

function setDependencyValue(
  json: PackageJsonDocument,
  section: DependencySection,
  packageName: string,
  value: string,
): void {
  const dependencies = json[section];
  if (isRecord(dependencies)) {
    dependencies[packageName] = value;
    return;
  }
  if (Array.isArray(dependencies)) {
    (dependencies as unknown as Record<string, unknown>)[packageName] = value;
  }
}

function sortDependencyMap(dependencies: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right)),
  );
}

interface OwnDependencySpec {
  section: Record<string, unknown> | undefined;
  valid: boolean;
  present: boolean;
  value: unknown;
}

function readOwnDependencySpec(section: unknown, packageName: string): OwnDependencySpec {
  if (section === undefined) {
    return { section: undefined, valid: true, present: false, value: undefined };
  }
  if (!isRecord(section)) {
    return { section: undefined, valid: false, present: false, value: section };
  }

  const dependencySection = section as Record<string, unknown>;
  const present = Object.hasOwn(dependencySection, packageName);
  return {
    section: dependencySection,
    valid: true,
    present,
    value: present ? dependencySection[packageName] : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function detectJsonIndent(raw: string): string {
  const match = raw.match(/^[ \t]+"[^"]+":/m);
  if (match === null) {
    return '  ';
  }
  return match[0].match(/^[ \t]+/)?.[0] ?? '  ';
}

function detectNewlineStyle(raw: string): string {
  return raw.match(/\r\n|\r|\n/)?.[0] ?? '\n';
}

const CONFLICT_ANSI_ESCAPE = new RegExp(
  `${String.fromCharCode(27)}(?:\\][^${String.fromCharCode(7)}]*(?:${String.fromCharCode(7)}|${String.fromCharCode(27)}\\\\)|\\[[0-?]*[ -/]*[@-~])`,
  'g',
);
const CONFLICT_CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  'g',
);

function sanitizeConflictText(value: unknown): string {
  if (typeof value !== 'string') {
    if (value === undefined) {
      return '<missing>';
    }
    if (value === null) {
      return '<null>';
    }
    return Array.isArray(value) ? '<array>' : `<${typeof value}>`;
  }

  return value
    .replace(CONFLICT_ANSI_ESCAPE, '')
    .replace(CONFLICT_CONTROL, ' ')
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .slice(0, 240);
}