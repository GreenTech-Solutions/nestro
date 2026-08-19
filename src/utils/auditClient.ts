import { logger } from './logger';
import { runBoundedProcess } from './processRunner';
import type { BoundedProcessOutcome } from './processRunner';

export type AuditSeverity = 'critical' | 'high' | 'moderate' | 'low' | 'info';

/**
 * Audit processes are given a generous but finite timeout: Yarn's full-graph recursive
 * audit and slow registries can legitimately take a while, but Node's own default
 * (`timeout: 0`, i.e. unbounded) is what let a stalled process hold `Running audit…`
 * forever (`ARC-07`).
 */
export const AUDIT_PROCESS_TIMEOUT_MS = 120_000;

/**
 * A large monorepo's audit JSON can comfortably exceed Node's 1MB `maxBuffer` default,
 * which otherwise turns a perfectly valid large report into a false `overflow`. 20MB
 * stays a real, enforced bound rather than the previous implicit/undocumented default.
 */
export const AUDIT_PROCESS_MAX_BUFFER_BYTES = 20 * 1024 * 1024;

export interface AuditResult {
  vulnerabilities: Map<string, AuditSeverity>;
  total: number;
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
    // The process was terminated before it produced a complete result (`ARC-07`): none
    // of these three ever carry inspectable output, so they can never become `clean`.
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
  /** The `vulnerabilities` or `advisories` object of the recognized schema. */
  entries: Record<string, unknown>;
  /** `metadata.vulnerabilities.total` when the summary marker exposes it. */
  summaryTotal: number | undefined;
}

export async function runNpmAudit(cwd: string, signal?: AbortSignal): Promise<AuditResult> {
  logger.info(`Running npm audit in ${cwd}.`);
  return toAuditResult(await runAuditOutcome('npm', ['audit', '--json'], cwd, signal));
}

export async function runPackageAudit(
  packageManager: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<AuditResult> {
  logger.info(`Running ${packageManager} audit in ${cwd}.`);
  return toAuditResult(await runAuditOutcome(packageManager, ['audit', '--json'], cwd, signal));
}

/**
 * Runs an npm/pnpm-shaped audit command, bounded by a timeout, output cap and optional
 * cancellation `signal` (`ARC-07`), and classifies the run as clean, advisories,
 * incomplete or error. Advisory exit codes are accepted, but only together with a
 * recognized schema; a process that was terminated before it exited is always
 * incomplete or error, never clean.
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
      // The only log call for this event (N5): runBoundedProcess() itself stays silent
      // so the domain layer — the only place that knows what a failure here actually
      // means to the user — is the single source of truth for every bounded-process
      // failure message, instead of the runner and its caller each logging their own
      // near-duplicate line.
      logger.error(outcome.detail, outcome.cause);
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
  logger.debug(`Raw ${command} audit output snippet: ${stdout.slice(0, 200)}`);

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

  const payload = recognizeAuditPayload(json);
  if (payload === undefined) {
    return incompleteOutcome(
      'unrecognized-schema',
      `${command} audit output does not match a known audit schema.`,
    );
  }

  const vulnerabilities = collectVulnerabilities(payload);
  if (vulnerabilities.size > 0) {
    logger.info(`Audit complete: ${vulnerabilities.size} vulnerable package(s).`);
    return {
      kind: 'advisories',
      schema: payload.schema,
      exitCode,
      vulnerabilities,
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
  return { kind: 'clean', schema: payload.schema, exitCode, vulnerabilities, total: 0 };
}

/**
 * Narrows a recognized outcome to the legacy result shape. Incomplete and error outcomes
 * throw, so a caller can never mistake them for an empty vulnerability set.
 */
export function toAuditResult(outcome: AuditOutcome): AuditResult {
  if (outcome.kind === 'clean' || outcome.kind === 'advisories') {
    return { vulnerabilities: outcome.vulnerabilities, total: outcome.total };
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
function recognizeAuditPayload(json: unknown): RecognizedAuditPayload | undefined {
  if (!isPlainObject(json)) {
    return undefined;
  }

  const hasSummary = isPlainObject(json.metadata);
  const summaryTotal = readSummaryTotal(json.metadata);

  if (isPlainObject(json.vulnerabilities) && (typeof json.auditReportVersion === 'number' || hasSummary)) {
    return { schema: 'npm-v2-vulnerabilities', entries: json.vulnerabilities, summaryTotal };
  }
  if (isPlainObject(json.advisories) && hasSummary) {
    return { schema: 'npm-v1-advisories', entries: json.advisories, summaryTotal };
  }
  return undefined;
}

function collectVulnerabilities(payload: RecognizedAuditPayload): Map<string, AuditSeverity> {
  const vulnerabilities = new Map<string, AuditSeverity>();

  for (const [key, info] of Object.entries(payload.entries)) {
    if (!isPlainObject(info)) {
      continue;
    }
    const name = payload.schema === 'npm-v2-vulnerabilities' ? readString(key) : readString(info.module_name);
    const severity = parseSeverity(readString(info.severity));
    if (name === undefined || severity === undefined) {
      continue;
    }
    const existing = vulnerabilities.get(name);
    vulnerabilities.set(name, existing === undefined ? severity : mergeSeverity(existing, severity));
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

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}