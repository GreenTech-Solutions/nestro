import { logger } from './logger';
import { runBoundedProcess } from './processRunner';
import type { BoundedProcessOutcome } from './processRunner';
import {
  createAuditAdvisory,
  inferPathAttribution,
  mergeAuditAdvisory,
} from './auditReport';
import type {
  AuditAdvisory,
  AuditAttribution,
  AuditFixAvailability,
  AuditVia,
} from './auditReport';

export type AuditSeverity = 'critical' | 'high' | 'moderate' | 'low' | 'info';
export type AuditPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/**
 * Generous but finite: Yarn's full-graph recursive audit and slow registries can legitimately
 * take a while, but Node's default (`timeout: 0`, unbounded) is what let a stalled process
 * hold `Running audit…` forever.
 */
export const AUDIT_PROCESS_TIMEOUT_MS = 120_000;

/**
 * A large monorepo's audit JSON can comfortably exceed Node's 1MB `maxBuffer` default,
 * which would otherwise turn a valid large report into a false `overflow`. 20MB is a
 * deliberate, enforced bound.
 */
export const AUDIT_PROCESS_MAX_BUFFER_BYTES = 20 * 1024 * 1024;

export interface AuditResult {
  vulnerabilities: Map<string, AuditSeverity>;
  total: number;
  advisories: readonly AuditAdvisory[];
  manager: AuditPackageManager;
  schema: AuditSchemaId;
}

/**
 * Audit JSON schemas recognized by the manager-specific adapters. The shared parser in
 * this module still recognizes only npm/pnpm shapes; Bun owns its bulk-advisory adapter.
 */
export type AuditSchemaId
  = | 'npm-v2-vulnerabilities'
    | 'npm-v1-advisories'
    | 'bun-bulk-advisory'
    | 'yarn-classic-audit'
    | 'yarn-modern-npm-audit';

/** Why audit output could not be turned into a recognized result. */
export type AuditIncompleteReason
  = | 'empty-output'
    | 'malformed-json'
    | 'unrecognized-schema'
    | 'unexpected-exit'
    | 'summary-mismatch'
    | 'unknown-yarn-family'
    // The process was terminated before it produced a complete result: none of these
    // three ever carry inspectable output, so they can never become `clean`.
    | 'timeout'
    | 'aborted'
    | 'output-overflow';

/** Why the audit process itself never produced output that could be inspected. */
export type AuditErrorReason = 'command-not-found' | 'process-failed';

/** One audit process run, normalized so the parser stays pure and testable. */
export interface AuditExecution {
  /** Executable that produced the output; used for log and error text only. */
  command: string;
  stdout: string;
  /** Process exit code, or `undefined` when the process never reported one. */
  exitCode: number | undefined;
}

interface AuditRecognizedOutcomeBase {
  schema: AuditSchemaId;
  /** Exit code the recognized schema was accepted with. */
  exitCode: number;
  vulnerabilities: Map<string, AuditSeverity>;
  total: number;
  /** Structured entries; optional for backwards-compatible hand-authored outcomes. */
  advisories?: readonly AuditAdvisory[];
  manager?: AuditPackageManager;
}

/** Confirmed absence of vulnerabilities: recognized schema plus a compatible exit code. */
export interface AuditCleanOutcome extends AuditRecognizedOutcomeBase {
  kind: 'clean';
  total: 0;
}

/** Recognized schema that reported at least one readable advisory. */
export interface AuditAdvisoriesOutcome extends AuditRecognizedOutcomeBase {
  kind: 'advisories';
}

/** Output was received but is not a recognized result; it must never read as clean. */
export interface AuditIncompleteOutcome {
  kind: 'incomplete';
  reason: AuditIncompleteReason;
  detail: string;
}

/** The audit process failed before any inspectable output existed. */
export interface AuditErrorOutcome {
  kind: 'error';
  reason: AuditErrorReason;
  detail: string;
}

export type AuditOutcome
  = | AuditCleanOutcome
    | AuditAdvisoriesOutcome
    | AuditIncompleteOutcome
    | AuditErrorOutcome;

/** Raised when an audit run produced no recognized result, so no clean state may be inferred. */
export class UnrecognizedAuditResultError extends Error {
  readonly outcome: AuditIncompleteOutcome | AuditErrorOutcome;

  constructor(outcome: AuditIncompleteOutcome | AuditErrorOutcome) {
    super(outcome.detail);
    this.name = 'UnrecognizedAuditResultError';
    this.outcome = outcome;
  }
}

const severityOrder: AuditSeverity[] = ['critical', 'high', 'moderate', 'low', 'info'];

/** npm and pnpm exit 0 without findings and 1 when advisories were reported. */
const compatibleExitCodes: readonly number[] = [0, 1];

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
  return toAuditResult(await runAuditOutcome('npm', ['audit', '--json'], cwd, signal));
}

export async function runPackageAudit(
  packageManager: 'npm' | 'pnpm',
  cwd: string,
  signal?: AbortSignal,
): Promise<AuditResult> {
  logger.info(`Running ${packageManager} audit.`);
  return toAuditResult(await runAuditOutcome(packageManager, ['audit', '--json'], cwd, signal));
}

/**
 * Runs an npm/pnpm-shaped audit command, bounded by a timeout, output cap and optional
 * cancellation `signal`, then classifies the run as clean, advisories, incomplete or error.
 * Advisory exit codes are accepted only together with a recognized schema.
 */
export async function runAuditOutcome(
  command: string,
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<AuditOutcome> {
  const outcome = await runBoundedProcess(command, args, {
    cwd,
    timeoutMs: AUDIT_PROCESS_TIMEOUT_MS,
    maxBufferBytes: AUDIT_PROCESS_MAX_BUFFER_BYTES,
    signal,
  });
  if (outcome.kind !== 'exit') {
    return describeBoundedProcessFailure(command, outcome);
  }
  return parseAuditOutcome({ command, stdout: outcome.stdout, exitCode: outcome.exitCode });
}

/**
 * Translates every non-`exit` runner outcome into the matching incomplete/error audit
 * outcome. Shared by every manager-specific runner (npm/pnpm, Yarn, Bun) so the timeout,
 * cancel, overflow and spawn-error mapping is defined — and tested — exactly once.
 */
export function describeBoundedProcessFailure(
  command: string,
  outcome: Exclude<BoundedProcessOutcome, { kind: 'exit' }>,
): AuditIncompleteOutcome | AuditErrorOutcome {
  switch (outcome.kind) {
    case 'timeout':
      return incompleteOutcome(
        'timeout',
        `${command} audit timed out after ${outcome.timeoutMs}ms and was terminated.`,
      );
    case 'aborted':
      return incompleteOutcome('aborted', `${command} audit was cancelled before it produced a result.`);
    case 'overflow':
      return incompleteOutcome(
        'output-overflow',
        `${command} audit output exceeded the ${outcome.maxBufferBytes}-byte limit and was terminated; `
        + 'partial output is never treated as a result.',
      );
    case 'spawn-error':
      // The only log call for this event: runBoundedProcess() itself stays silent so the
      // domain layer — the only place that knows what a failure means to the user — is
      // the single source of truth for every bounded-process failure message.
      logger.error('Audit process could not start; see the security audit report for redacted details.');
      return { kind: 'error', reason: outcome.reason, detail: outcome.detail };
  }
}

/**
 * Classifies one audit run. A clean result requires a documented npm/pnpm schema, a
 * compatible exit code and a summary that agrees with the parsed advisories; anything
 * else stays incomplete.
 */
export function parseAuditOutcome(execution: AuditExecution): AuditOutcome {
  const { command, exitCode, stdout } = execution;
  logger.debug(`${command} audit output received (${stdout.length} bytes).`);

  if (exitCode === undefined || !compatibleExitCodes.includes(exitCode)) {
    return incompleteOutcome(
      'unexpected-exit',
      `${command} audit exited with an unexpected code (${exitCode ?? 'none'}).`,
    );
  }

  const output = stdout.trim();
  if (output === '') {
    return incompleteOutcome('empty-output', `${command} audit produced no output.`);
  }

  let json: unknown;
  try {
    json = JSON.parse(output);
  }
  catch (err) {
    return incompleteOutcome(
      'malformed-json',
      `${command} audit output is not valid JSON: ${describeError(err)}`,
    );
  }

  const manager = managerForCommand(command);
  if (manager === undefined) {
    return incompleteOutcome(
      'unrecognized-schema',
      `${command} audit is not handled by the npm/pnpm audit adapter.`,
    );
  }
  const payload = recognizeAuditPayload(json, manager);
  if (payload === undefined) {
    return incompleteOutcome(
      'unrecognized-schema',
      `${command} audit output does not match a known audit schema.`,
    );
  }

  const advisories = collectAdvisories(payload);
  const vulnerabilities = collectVulnerabilities(advisories);
  if (vulnerabilities.size > 0) {
    logger.info(`Audit complete: ${vulnerabilities.size} vulnerable package(s).`);
    return {
      kind: 'advisories',
      schema: payload.schema,
      manager: payload.manager,
      exitCode,
      vulnerabilities,
      advisories,
      total: vulnerabilities.size,
    };
  }

  if (payload.summaryTotal !== undefined && payload.summaryTotal > 0) {
    return incompleteOutcome(
      'summary-mismatch',
      `${command} audit summary reports ${payload.summaryTotal} vulnerability(ies) but no advisory could be read.`,
    );
  }

  if (exitCode !== 0) {
    return incompleteOutcome(
      'unexpected-exit',
      `${command} audit reported no advisories but exited with code ${exitCode}.`,
    );
  }

  logger.info('Audit complete: 0 vulnerable package(s).');
  return {
    kind: 'clean',
    schema: payload.schema,
    manager: payload.manager,
    exitCode,
    vulnerabilities,
    advisories,
    total: 0,
  };
}

/**
 * Narrows a recognized outcome to the legacy result shape. Incomplete and error outcomes
 * throw, so a caller can never mistake them for an empty vulnerability set.
 */
export function toAuditResult(outcome: AuditOutcome, managerOverride?: AuditPackageManager): AuditResult {
  if (outcome.kind === 'clean' || outcome.kind === 'advisories') {
    const manager = managerOverride ?? outcome.manager ?? managerForSchema(outcome.schema);
    return {
      vulnerabilities: outcome.vulnerabilities,
      total: outcome.total,
      advisories: (outcome.advisories ?? []).map(advisory => ({
        ...advisory,
        manager,
      })),
      manager,
      schema: outcome.schema,
    };
  }
  throw new UnrecognizedAuditResultError(outcome);
}

export function mergeSeverity(left: AuditSeverity, right: AuditSeverity): AuditSeverity {
  return severityOrder.indexOf(left) <= severityOrder.indexOf(right) ? left : right;
}

export function parseSeverity(value: string | undefined): AuditSeverity | undefined {
  return severityOrder.find(severity => severity === value);
}

function incompleteOutcome(reason: AuditIncompleteReason, detail: string): AuditIncompleteOutcome {
  logger.warn(detail);
  return { kind: 'incomplete', reason, detail };
}

/**
 * Accepts only the two documented npm/pnpm report shapes, each together with its own
 * version or summary marker, so an unknown or future schema is never guessed at.
 */
function recognizeAuditPayload(json: unknown, manager: AuditPackageManager): RecognizedAuditPayload | undefined {
  if (!isPlainObject(json)) {
    return undefined;
  }

  const hasSummary = isPlainObject(json.metadata);
  const summaryTotal = readSummaryTotal(json.metadata);

  if (isPlainObject(json.vulnerabilities) && (typeof json.auditReportVersion === 'number' || hasSummary)) {
    return { schema: 'npm-v2-vulnerabilities', manager, entries: json.vulnerabilities, summaryTotal };
  }
  if (isPlainObject(json.advisories) && hasSummary) {
    return { schema: 'npm-v1-advisories', manager, entries: json.advisories, summaryTotal };
  }
  return undefined;
}

function collectAdvisories(payload: RecognizedAuditPayload): AuditAdvisory[] {
  const advisories = new Map<string, AuditAdvisory>();

  for (const [key, info] of Object.entries(payload.entries)) {
    if (!isPlainObject(info)) {
      continue;
    }
    const packageName = payload.schema === 'npm-v2-vulnerabilities'
      ? readString(info.name) ?? (isLikelyPackageName(key) ? readString(key) : undefined)
      : readString(info.module_name);
    const severity = parseSeverity(readString(info.severity));
    if (packageName === undefined || severity === undefined) {
      continue;
    }

    const paths = readStringArray(info.nodes)
      .concat(readStringArray(info.paths))
      .concat(readSingleString(info.resolvedPath));
    const versions = readStringArray(info.versions)
      .concat(readSingleString(info.version))
      .concat(readSingleString(info.resolvedVersion))
      .concat(readSingleString(info.installedVersion));
    const direct = typeof info.isDirect === 'boolean' ? info.isDirect : undefined;
    const baseAttribution = direct === true
      ? 'direct'
      : direct === false
        ? 'transitive'
        : inferPathAttribution(packageName, paths);
    const via = parseVia(info.via);
    const fixAvailable = parseFixAvailable(info.fixAvailable ?? info.fix_available);
    const base = {
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
      attribution: baseAttribution as AuditAttribution,
      via,
      fixAvailable,
    };

    const viaAdvisories = via.filter(entry => entry.url !== undefined || entry.id !== undefined || entry.source !== undefined);
    const findings = payload.schema === 'npm-v1-advisories' && Array.isArray(info.findings)
      ? info.findings.filter(isPlainObject)
      : [];
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
      mergeAuditAdvisory(advisories, createAuditAdvisory({
        ...base,
        advisoryId: readIdentity(info.id),
      }));
    }

    if (payload.schema === 'npm-v1-advisories') {
      if (findings.length > 0) {
        // npm v1 puts the resolved path/version/directness only on each finding;
        // only findings become advisories so no graph evidence is invented.
        for (const finding of findings) {
          const findingPaths = readStringArray(finding.paths);
          const findingVersion = readString(finding.version);
          const findingAttribution = typeof finding.isDirect === 'boolean'
            ? finding.isDirect ? 'direct' : 'transitive'
            : inferPathAttribution(packageName, findingPaths);
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
    }
  }

  return [...advisories.values()].sort((left, right) => left.identity.localeCompare(right.identity));
}

function collectVulnerabilities(advisories: readonly AuditAdvisory[]): Map<string, AuditSeverity> {
  const vulnerabilities = new Map<string, AuditSeverity>();
  for (const advisory of advisories) {
    const existing = vulnerabilities.get(advisory.packageName);
    vulnerabilities.set(
      advisory.packageName,
      existing === undefined ? advisory.severity : mergeSeverity(existing, advisory.severity),
    );
  }
  return vulnerabilities;
}

function readSummaryTotal(metadata: unknown): number | undefined {
  if (!isPlainObject(metadata) || !isPlainObject(metadata.vulnerabilities)) {
    return undefined;
  }
  const { total } = metadata.vulnerabilities;
  return typeof total === 'number' ? total : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function parseFixAvailable(value: unknown): AuditFixAvailability | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (!isPlainObject(value)) {
    return undefined;
  }
  const name = readString(value.name);
  const version = readString(value.version);
  const isSemVerMajor = typeof value.isSemVerMajor === 'boolean' ? value.isSemVerMajor : undefined;
  if (name === undefined && version === undefined && isSemVerMajor === undefined) {
    return undefined;
  }
  return { name, version, isSemVerMajor };
}

function parseVia(value: unknown): AuditVia[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry): AuditVia[] => {
    if (typeof entry === 'string' && entry !== '') {
      return [{ identity: entry }];
    }
    if (!isPlainObject(entry)) {
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
  if (command === 'npm') {
    return 'npm';
  }
  if (command === 'pnpm') {
    return 'pnpm';
  }
  return undefined;
}

function managerForSchema(schema: AuditSchemaId): AuditPackageManager {
  if (schema === 'npm-v1-advisories' || schema === 'npm-v2-vulnerabilities') {
    return 'npm';
  }
  if (schema.startsWith('yarn-')) {
    return 'yarn';
  }
  return 'bun';
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}