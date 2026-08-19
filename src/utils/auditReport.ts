import type { AuditPackageManager, AuditSchemaId, AuditSeverity } from './auditClient';

const REPORT_ANSI_ESCAPE = new RegExp(
  `${String.fromCharCode(27)}(?:\\][^${String.fromCharCode(7)}]*(?:${String.fromCharCode(7)}|${String.fromCharCode(27)}\\\\)|\\[[0-?]*[ -/]*[@-~])`,
  'g',
);
const REPORT_CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  'g',
);

export type AuditAttribution = 'direct' | 'transitive' | 'unknown';

export interface AuditFix {
  readonly name?: string;
  readonly version?: string;
  readonly isSemVerMajor?: boolean;
}

export type AuditFixAvailability = boolean | AuditFix;
export type AuditIdentityStability = 'stable' | 'unstable';

export function sanitizeAuditText(value: string, maxLength = 240): string {
  return value
    .replace(REPORT_ANSI_ESCAPE, '')
    .replace(REPORT_CONTROL, '')
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .slice(0, maxLength);
}

/** A safe, normalized dependency that caused or explains an advisory. */
export interface AuditVia {
  readonly identity: string;
  readonly id?: string;
  readonly source?: string;
  readonly name?: string;
  readonly dependency?: string;
  readonly title?: string;
  readonly url?: string;
  readonly severity?: AuditSeverity;
  readonly range?: string;
}

/**
 * One normalized advisory. Optional fields are intentionally omitted when the manager
 * does not provide them; the report must not manufacture a resolved path or version.
 */
export interface AuditAdvisory {
  readonly identity: string;
  readonly identityStability: AuditIdentityStability;
  readonly packageName: string;
  readonly severity: AuditSeverity;
  readonly manager: AuditPackageManager;
  readonly schema: AuditSchemaId;
  readonly advisoryId?: string;
  readonly source?: string;
  readonly sources: readonly string[];
  readonly title?: string;
  readonly titles: readonly string[];
  readonly url?: string;
  readonly urls: readonly string[];
  readonly affectedRange?: string;
  readonly affectedRanges: readonly string[];
  readonly resolvedPaths: readonly string[];
  readonly resolvedVersions: readonly string[];
  readonly attribution: AuditAttribution;
  readonly via: readonly AuditVia[];
  readonly fixAvailable?: AuditFixAvailability;
}

export interface AuditAdvisoryInput {
  readonly identity?: string;
  readonly identityStability?: AuditIdentityStability;
  readonly packageName: string;
  readonly severity: AuditSeverity;
  readonly manager: AuditPackageManager;
  readonly schema: AuditSchemaId;
  readonly advisoryId?: string;
  readonly source?: string;
  readonly title?: string;
  readonly url?: string;
  readonly affectedRange?: string;
  readonly resolvedPaths?: readonly string[];
  readonly resolvedVersions?: readonly string[];
  readonly attribution?: AuditAttribution;
  readonly via?: readonly AuditVia[];
  readonly fixAvailable?: AuditFixAvailability;
}

export function createAuditAdvisory(input: AuditAdvisoryInput): AuditAdvisory {
  const sources = input.source === undefined ? [] : [input.source];
  const titles = input.title === undefined ? [] : [input.title];
  const urls = input.url === undefined ? [] : [input.url];
  const affectedRanges = input.affectedRange === undefined ? [] : [input.affectedRange];
  const identity = input.identity ?? buildAdvisoryIdentity({
    manager: input.manager,
    schema: input.schema,
    packageName: input.packageName,
    advisoryId: input.advisoryId,
    source: input.source,
    url: input.url,
    title: input.title,
    affectedRange: input.affectedRange,
  });
  return {
    identity,
    identityStability: input.identityStability ?? (input.identity === undefined
      ? getAdvisoryIdentityStability(input)
      : 'stable'),
    packageName: input.packageName,
    severity: input.severity,
    manager: input.manager,
    schema: input.schema,
    advisoryId: input.advisoryId,
    source: input.source,
    sources,
    title: input.title,
    titles,
    url: input.url,
    urls,
    affectedRange: input.affectedRange,
    affectedRanges,
    resolvedPaths: uniqueSorted(input.resolvedPaths ?? []),
    resolvedVersions: uniqueSorted(input.resolvedVersions ?? []),
    attribution: input.attribution ?? 'unknown',
    via: uniqueVia(input.via ?? []),
    fixAvailable: input.fixAvailable,
  };
}

/**
 * Merges a normalized advisory into a stable identity map. The map key is deliberately
 * manager/schema-aware: the same package can be reported by independent projects and
 * distinct advisories for one package must not collapse merely because their severity is
 * equal. A stable advisory ID or canonical URL is preferred, with a deterministic,
 * explicitly unstable title/range fallback.
 */
export function mergeAuditAdvisory(
  advisories: Map<string, AuditAdvisory>,
  advisory: AuditAdvisory,
): void {
  const previous = advisories.get(advisory.identity);
  advisories.set(advisory.identity, previous === undefined ? advisory : mergeAdvisory(previous, advisory));
}

export function mergeAuditAdvisories(advisories: readonly AuditAdvisory[]): AuditAdvisory[] {
  const merged = new Map<string, AuditAdvisory>();
  for (const advisory of advisories) {
    mergeAuditAdvisory(merged, advisory);
  }
  return [...merged.values()].sort(compareAdvisories);
}

export function compareAdvisories(left: AuditAdvisory, right: AuditAdvisory): number {
  return left.packageName.localeCompare(right.packageName)
    || left.identity.localeCompare(right.identity)
    || right.severity.localeCompare(left.severity);
}

export function cloneAuditAdvisory(advisory: AuditAdvisory): AuditAdvisory {
  return {
    ...advisory,
    sources: [...advisory.sources],
    titles: [...advisory.titles],
    urls: [...advisory.urls],
    affectedRanges: [...advisory.affectedRanges],
    resolvedPaths: [...advisory.resolvedPaths],
    resolvedVersions: [...advisory.resolvedVersions],
    via: advisory.via.map(via => ({ ...via })),
    fixAvailable: typeof advisory.fixAvailable === 'object' && advisory.fixAvailable !== null
      ? { ...advisory.fixAvailable }
      : advisory.fixAvailable,
  };
}

export function mergeAttribution(
  left: AuditAttribution,
  right: AuditAttribution,
): AuditAttribution {
  return left === right ? left : 'unknown';
}

export function inferPathAttribution(packageName: string, paths: readonly string[]): AuditAttribution {
  if (paths.length === 0) {
    return 'unknown';
  }
  const attributions = new Set(paths.map(path => inferSinglePathAttribution(packageName, path)));
  return attributions.size === 1 ? [...attributions][0] : 'unknown';
}

export function mergePathAttributions(
  values: readonly AuditAttribution[],
): AuditAttribution {
  const known = values.filter(value => value !== 'unknown');
  if (known.length === 0) {
    return 'unknown';
  }
  const unique = new Set(known);
  return unique.size === 1 && values.every(value => value === known[0] || value === 'unknown')
    ? known[0]
    : 'unknown';
}

function mergeAdvisory(left: AuditAdvisory, right: AuditAdvisory): AuditAdvisory {
  const sources = uniqueSorted([...left.sources, ...right.sources]);
  const titles = uniqueSorted([...left.titles, ...right.titles]);
  const urls = uniqueSorted([...left.urls, ...right.urls]);
  const affectedRanges = uniqueSorted([...left.affectedRanges, ...right.affectedRanges]);
  return {
    ...left,
    severity: mergeSeverity(left.severity, right.severity),
    source: sources[0],
    sources,
    title: titles[0],
    titles,
    url: urls[0],
    urls,
    affectedRange: affectedRanges[0],
    affectedRanges,
    resolvedPaths: uniqueSorted([...left.resolvedPaths, ...right.resolvedPaths]),
    resolvedVersions: uniqueSorted([...left.resolvedVersions, ...right.resolvedVersions]),
    attribution: mergeAttribution(left.attribution, right.attribution),
    via: uniqueVia([...left.via, ...right.via]),
    fixAvailable: mergeFixAvailability(left.fixAvailable, right.fixAvailable),
  };
}

function buildAdvisoryIdentity(input: {
  manager: AuditPackageManager;
  schema: AuditSchemaId;
  packageName: string;
  advisoryId?: string;
  source?: string;
  url?: string;
  title?: string;
  affectedRange?: string;
}): string {
  const identity = input.advisoryId ?? input.url
    ?? `${input.title ?? ''}\0${input.affectedRange ?? ''}`;
  return [input.manager, input.schema, input.packageName, identity].join('\0');
}

function getAdvisoryIdentityStability(input: AuditAdvisoryInput): AuditIdentityStability {
  return input.advisoryId !== undefined || input.url !== undefined
    ? 'stable'
    : 'unstable';
}

function mergeSeverity(left: AuditSeverity, right: AuditSeverity): AuditSeverity {
  const order: readonly AuditSeverity[] = ['critical', 'high', 'moderate', 'low', 'info'];
  return order.indexOf(left) <= order.indexOf(right) ? left : right;
}

function mergeFixAvailability(
  left: AuditFixAvailability | undefined,
  right: AuditFixAvailability | undefined,
): AuditFixAvailability | undefined {
  if (left === undefined || right === undefined) {
    return left === right ? left : undefined;
  }
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    return left === right ? left : undefined;
  }
  return JSON.stringify(left) === JSON.stringify(right)
    ? left
    : undefined;
}

function uniqueVia(via: readonly AuditVia[]): AuditVia[] {
  const byIdentity = new Map<string, AuditVia>();
  for (const entry of via) {
    const previous = byIdentity.get(entry.identity);
    byIdentity.set(entry.identity, previous === undefined ? { ...entry } : mergeViaEntry(previous, entry));
  }
  return [...byIdentity.values()].sort((left, right) => left.identity.localeCompare(right.identity));
}

function mergeViaEntry(left: AuditVia, right: AuditVia): AuditVia {
  return {
    ...left,
    id: chooseStableString(left.id, right.id),
    source: chooseStableString(left.source, right.source),
    name: chooseStableString(left.name, right.name),
    dependency: chooseStableString(left.dependency, right.dependency),
    title: chooseStableString(left.title, right.title),
    url: chooseStableString(left.url, right.url),
    severity: left.severity === undefined
      ? right.severity
      : right.severity === undefined
        ? left.severity
        : mergeSeverity(left.severity, right.severity),
    range: chooseStableString(left.range, right.range),
  };
}

function chooseStableString(left: string | undefined, right: string | undefined): string | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined || left === right) {
    return left;
  }
  return [left, right].sort((a, b) => a.localeCompare(b))[0];
}

function inferSinglePathAttribution(packageName: string, value: string): AuditAttribution {
  const path = value.trim().replace(/\\/g, '/');
  if (path === '' || path === 'workspace:.' || path === 'workspace:root') {
    return 'direct';
  }
  const nodeModuleCount = path.split('/').filter(segment => segment === 'node_modules').length;
  if (nodeModuleCount > 1) {
    return 'transitive';
  }
  const dependencyChain = path.split('>').map(segment => segment.trim());
  const chainLeaf = dependencyChain.at(-1);
  if (dependencyChain.length > 1
    && chainLeaf !== undefined
    && (chainLeaf === packageName || chainLeaf.startsWith(`${packageName}@`))) {
    return 'transitive';
  }
  if (path === packageName || path === `node_modules/${packageName}` || path.endsWith(`/node_modules/${packageName}`)) {
    return 'direct';
  }
  return 'unknown';
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter(value => value.trim() !== ''))].sort((left, right) => left.localeCompare(right));
}