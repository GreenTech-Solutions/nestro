import { buildRecognizedOutcome, incompleteOutcome, readAuditJsonDocument, runAuditCommand, toAuditResult } from './audit/outcome';
import type { AuditExecution, AuditOutcome, AuditResult } from './audit/outcome';
import { parseFixAvailable } from './audit/fields';
import { parseSeverity } from './audit/types';
import type { AuditPackageManager, AuditSchemaId } from './audit/types';
import { logger } from './logger';
import {
  createAuditAdvisory,
  inferPathAttribution,
  mergeAuditAdvisory,
} from './auditReport';
import type {
  AuditAdvisory,
  AuditAttribution,
  AuditVia,
} from './auditReport';
import { isRecord, PACKAGE_MANAGERS } from '../shared';

interface RecognizedAuditPayload {
  schema: AuditSchemaId;
  manager: AuditPackageManager;
  /** The `vulnerabilities` or `advisories` object of the recognized schema. */
  entries: Record<string, unknown>;
  /** `metadata.vulnerabilities.total` when the summary marker exposes it. */
  summaryTotal: number | undefined;
}

export async function runNpmAudit(cwd: string, signal?: AbortSignal): Promise<AuditResult> {
  logger.info('Running npm audit.');
  return toAuditResult(await runAuditOutcome(PACKAGE_MANAGERS.npm.bin, PACKAGE_MANAGERS.npm.dialect.audit, cwd, signal));
}

export async function runPackageAudit(
  packageManager: 'npm' | 'pnpm',
  cwd: string,
  signal?: AbortSignal,
): Promise<AuditResult> {
  logger.info(`Running ${packageManager} audit.`);
  return toAuditResult(await runAuditOutcome(
    PACKAGE_MANAGERS[packageManager].bin,
    PACKAGE_MANAGERS[packageManager].dialect.audit,
    cwd,
    signal,
  ));
}

/**
 * Runs an npm/pnpm-shaped audit command and classifies the run as clean, advisories,
 * incomplete or error. Advisory exit codes are accepted only together with a recognized schema.
 */
export function runAuditOutcome(
  command: string,
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<AuditOutcome> {
  return runAuditCommand({ command, args, cwd, signal }, parseAuditOutcome);
}

/**
 * Classifies one audit run. A clean result requires a documented npm/pnpm schema, a
 * compatible exit code and a summary that agrees with the parsed advisories; anything
 * else stays incomplete.
 */
export function parseAuditOutcome(execution: AuditExecution): AuditOutcome {
  const { command } = execution;
  const document = readAuditJsonDocument(execution);
  if (document.kind !== 'json') {
    return document;
  }

  const manager = managerForCommand(command);
  if (manager === undefined) {
    return incompleteOutcome(
      'unrecognized-schema',
      `${command} audit is not handled by the npm/pnpm audit adapter.`,
    );
  }
  const payload = recognizeAuditPayload(document.json, manager);
  if (payload === undefined) {
    return incompleteOutcome(
      'unrecognized-schema',
      `${command} audit output does not match a known audit schema.`,
    );
  }

  const advisories = collectAdvisories(payload);
  if (advisories.length === 0) {
    if (payload.summaryTotal !== undefined && payload.summaryTotal > 0) {
      return incompleteOutcome(
        'summary-mismatch',
        `${command} audit summary reports ${payload.summaryTotal} vulnerability(ies) but no advisory could be read.`,
      );
    }
    if (document.exitCode !== 0) {
      return incompleteOutcome(
        'unexpected-exit',
        `${command} audit reported no advisories but exited with code ${document.exitCode}.`,
      );
    }
  }
  return buildRecognizedOutcome(payload.schema, payload.manager, document.exitCode, advisories);
}

/**
 * Accepts only the two documented npm/pnpm report shapes, each together with its own
 * version or summary marker, so an unknown or future schema is never guessed at.
 */
function recognizeAuditPayload(json: unknown, manager: AuditPackageManager): RecognizedAuditPayload | undefined {
  if (!isRecord(json)) {
    return undefined;
  }

  const hasSummary = isRecord(json.metadata);
  const summaryTotal = readSummaryTotal(json.metadata);

  if (isRecord(json.vulnerabilities) && (typeof json.auditReportVersion === 'number' || hasSummary)) {
    return { schema: 'npm-v2-vulnerabilities', manager, entries: json.vulnerabilities, summaryTotal };
  }
  if (isRecord(json.advisories) && hasSummary) {
    return { schema: 'npm-v1-advisories', manager, entries: json.advisories, summaryTotal };
  }
  return undefined;
}

function collectAdvisories(payload: RecognizedAuditPayload): AuditAdvisory[] {
  const advisories = new Map<string, AuditAdvisory>();
  for (const [key, info] of Object.entries(payload.entries)) {
    if (isRecord(info)) {
      collectAdvisoryEntry(advisories, payload, key, info);
    }
  }
  return [...advisories.values()];
}

function collectAdvisoryEntry(
  advisories: Map<string, AuditAdvisory>,
  payload: RecognizedAuditPayload,
  key: string,
  info: Record<string, unknown>,
): void {
  const packageName = payload.schema === 'npm-v2-vulnerabilities'
    ? readString(info.name) ?? (isLikelyPackageName(key) ? readString(key) : undefined)
    : readString(info.module_name);
  const severity = parseSeverity(readString(info.severity));
  if (packageName === undefined || severity === undefined) {
    return;
  }

  const base = createBaseAdvisory(payload, info, packageName, severity);
  const findings = payload.schema === 'npm-v1-advisories' && Array.isArray(info.findings)
    ? info.findings.filter(isRecord)
    : [];
  appendSummaryAdvisories(advisories, payload, info, base, findings);
  appendNpmV1Findings(advisories, payload, key, info, base, findings);
}

function createBaseAdvisory(
  payload: RecognizedAuditPayload,
  info: Record<string, unknown>,
  packageName: string,
  severity: NonNullable<ReturnType<typeof parseSeverity>>,
) {
  const paths = readStringArray(info.nodes)
    .concat(readStringArray(info.paths))
    .concat(readSingleString(info.resolvedPath));
  const versions = readStringArray(info.versions)
    .concat(readSingleString(info.version))
    .concat(readSingleString(info.resolvedVersion))
    .concat(readSingleString(info.installedVersion));
  const direct = typeof info.isDirect === 'boolean' ? info.isDirect : undefined;
  const attribution = direct === true
    ? 'direct'
    : direct === false
      ? 'transitive'
      : inferPathAttribution(packageName, paths);
  return {
    packageName,
    severity,
    manager: payload.manager,
    schema: payload.schema,
    source: readString(info.source),
    title: readString(info.title),
    url: readString(info.url),
    affectedRange: readString(info.range) ?? readString(info.vulnerableVersions) ?? readString(info.vulnerable_versions),
    resolvedPaths: paths,
    resolvedVersions: versions,
    attribution: attribution as AuditAttribution,
    via: parseVia(info.via),
    fixAvailable: parseFixAvailable(info.fixAvailable ?? info.fix_available),
  };
}

function appendSummaryAdvisories(
  advisories: Map<string, AuditAdvisory>,
  payload: RecognizedAuditPayload,
  info: Record<string, unknown>,
  base: ReturnType<typeof createBaseAdvisory>,
  findings: Record<string, unknown>[],
): void {
  const viaAdvisories = base.via.filter(entry => entry.url !== undefined || entry.id !== undefined || entry.source !== undefined);
  if (payload.schema === 'npm-v2-vulnerabilities' && viaAdvisories.length > 0) {
    for (const detail of viaAdvisories) {
      mergeAuditAdvisory(advisories, createAuditAdvisory({
        ...base,
        advisoryId: detail.id,
        source: detail.source ?? base.source,
        title: detail.title ?? base.title,
        url: detail.url ?? base.url,
        severity: detail.severity ?? base.severity,
        affectedRange: detail.range ?? base.affectedRange,
      }));
    }
  }
  else if (findings.length === 0) {
    mergeAuditAdvisory(advisories, createAuditAdvisory({ ...base, advisoryId: readIdentity(info.id) }));
  }
}

function appendNpmV1Findings(
  advisories: Map<string, AuditAdvisory>,
  payload: RecognizedAuditPayload,
  key: string,
  info: Record<string, unknown>,
  base: ReturnType<typeof createBaseAdvisory>,
  findings: Record<string, unknown>[],
): void {
  if (payload.schema !== 'npm-v1-advisories' || findings.length === 0) {
    return;
  }
  for (const finding of findings) {
    const findingPaths = readStringArray(finding.paths);
    const findingVersion = readString(finding.version);
    const findingAttribution = typeof finding.isDirect === 'boolean'
      ? finding.isDirect ? 'direct' : 'transitive'
      : inferPathAttribution(base.packageName, findingPaths);
    mergeAuditAdvisory(advisories, createAuditAdvisory({
      ...base,
      identity: undefined,
      advisoryId: readIdentity(info.id) ?? key,
      resolvedPaths: findingPaths,
      resolvedVersions: findingVersion === undefined ? [] : [findingVersion],
      attribution: findingAttribution,
    }));
  }
}

function readSummaryTotal(metadata: unknown): number | undefined {
  if (!isRecord(metadata) || !isRecord(metadata.vulnerabilities)) {
    return undefined;
  }
  const { total } = metadata.vulnerabilities;
  return typeof total === 'number' ? total : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function readSingleString(value: unknown): string[] {
  const result = readString(value);
  return result === undefined ? [] : [result];
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    : [];
}

function readIdentity(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return readString(value);
}

function isLikelyPackageName(value: string): boolean {
  return value.trim() !== '' && !/^\d+$/.test(value);
}

function parseVia(value: unknown): AuditVia[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry): AuditVia[] => {
    if (typeof entry === 'string' && entry !== '') {
      return [{ identity: entry }];
    }
    if (!isRecord(entry)) {
      return [];
    }
    const id = readIdentity(entry.id);
    const source = readIdentity(entry.source);
    const name = readString(entry.name);
    const dependency = readString(entry.dependency);
    const title = readString(entry.title);
    const url = readString(entry.url);
    const severity = parseSeverity(readString(entry.severity));
    const range = readString(entry.range) ?? readString(entry.vulnerableVersions);
    const identity = id ?? url ?? source ?? dependency ?? name ?? title;
    return identity === undefined
      ? []
      : [{ identity, id, source, name, dependency, title, url, severity, range }];
  });
}

function managerForCommand(command: string): AuditPackageManager | undefined {
  return command === 'npm' || command === 'pnpm' ? command : undefined;
}