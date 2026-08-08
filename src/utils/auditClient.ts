import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from './logger';

const execFileAsync = promisify(execFile);

export type AuditSeverity = 'critical' | 'high' | 'moderate' | 'low' | 'info';

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
    | 'unknown-yarn-family';

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

export async function runNpmAudit(cwd: string): Promise<AuditResult> {
  logger.info(`Running npm audit in ${cwd}.`);
  return toAuditResult(await runAuditOutcome('npm', ['audit', '--json'], cwd));
}

export async function runPackageAudit(packageManager: string, cwd: string): Promise<AuditResult> {
  logger.info(`Running ${packageManager} audit in ${cwd}.`);
  return toAuditResult(await runAuditOutcome(packageManager, ['audit', '--json'], cwd));
}

/**
 * Runs an npm/pnpm-shaped audit command and classifies the run as clean, advisories,
 * incomplete or error. Advisory exit codes are accepted, but only together with a
 * recognized schema.
 */
export async function runAuditOutcome(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<AuditOutcome> {
  try {
    const result = await execFileAsync(command, [...args], { cwd }) as { stdout: string } | string;
    const stdout = typeof result === 'string' ? result : result.stdout;
    return parseAuditOutcome({ command, stdout, exitCode: 0 });
  }
  catch (err) {
    const exitCode = getExecExitCode(err);
    if (exitCode !== undefined) {
      return parseAuditOutcome({ command, stdout: getExecStdout(err) ?? '', exitCode });
    }
    const detail = `${command} audit could not run: ${describeError(err)}`;
    logger.error(detail, err);
    return {
      kind: 'error',
      reason: isCommandNotFound(err) ? 'command-not-found' : 'process-failed',
      detail,
    };
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

export function getExecStdout(err: unknown): string | undefined {
  const { stdout } = readErrorProperties(err);
  return typeof stdout === 'string' ? stdout : undefined;
}

/** Exit code of a rejected child process, or `undefined` for spawn/signal failures. */
export function getExecExitCode(err: unknown): number | undefined {
  const { code } = readErrorProperties(err);
  return typeof code === 'number' ? code : undefined;
}

function isCommandNotFound(err: unknown): boolean {
  return readErrorProperties(err).code === 'ENOENT';
}

function readErrorProperties(err: unknown): { code?: unknown; stdout?: unknown } {
  if (typeof err !== 'object' || err === null) {
    return {};
  }
  return err as { code?: unknown; stdout?: unknown };
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