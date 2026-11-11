import { AUDIT_PROCESS_MAX_BUFFER_BYTES, AUDIT_PROCESS_TIMEOUT_MS } from '../../config';
import { compareCodeUnits, describeError } from '../../shared';
import type { AuditAdvisory } from '../auditReport';
import { logger } from '../logger';
import { runBoundedProcess } from '../processRunner';
import type { BoundedProcessOutcome } from '../processRunner';
import { mergeSeverity } from './types';
import type { AuditPackageManager, AuditSchemaId, AuditSeverity } from './types';

export interface AuditResult {
  vulnerabilities: Map<string, AuditSeverity>;
  total: number;
  advisories: readonly AuditAdvisory[];
  manager: AuditPackageManager;
  schema: AuditSchemaId;
}

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
  stderr?: string;
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

/** One audit process to run in a package root. */
export interface AuditCommand {
  command: string;
  args: readonly string[];
  cwd: string;
  signal?: AbortSignal;
}

type SpawnErrorOutcome = Extract<BoundedProcessOutcome, { kind: 'spawn-error' }>;

/** Exit codes npm, pnpm and Bun use: 0 without findings, 1 when advisories were reported. */
const ADVISORY_EXIT_CODES: readonly number[] = [0, 1];

export function incompleteOutcome(reason: AuditIncompleteReason, detail: string): AuditIncompleteOutcome {
  logger.warn(detail);
  return { kind: 'incomplete', reason, detail };
}

/**
 * Runs one audit command, bounded by a timeout, output cap and optional cancellation
 * signal, and hands a finished process to `parse`. Every other runner outcome maps to an
 * incomplete or error audit outcome here; `describeSpawnError` overrides the spawn failure.
 */
export async function runAuditCommand(
  audit: AuditCommand,
  parse: (execution: AuditExecution) => AuditOutcome,
  describeSpawnError?: (outcome: SpawnErrorOutcome) => AuditErrorOutcome,
): Promise<AuditOutcome> {
  const outcome = await runBoundedProcess(audit.command, audit.args, {
    cwd: audit.cwd,
    timeoutMs: AUDIT_PROCESS_TIMEOUT_MS,
    maxBufferBytes: AUDIT_PROCESS_MAX_BUFFER_BYTES,
    signal: audit.signal,
  });
  if (outcome.kind === 'spawn-error' && describeSpawnError !== undefined) {
    return describeSpawnError(outcome);
  }
  if (outcome.kind !== 'exit') {
    return describeBoundedProcessFailure(audit.command, outcome);
  }
  return parse({
    command: audit.command,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    exitCode: outcome.exitCode,
  });
}

/**
 * Translates every non-`exit` runner outcome into the matching incomplete/error audit
 * outcome, so the timeout, cancel, overflow and spawn-error mapping is defined exactly once.
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

export type AuditJsonDocument = { kind: 'json'; json: unknown; exitCode: number } | AuditIncompleteOutcome;

/** Checks the advisory exit code and parses stdout as one JSON document. */
export function readAuditJsonDocument(execution: AuditExecution): AuditJsonDocument {
  const { command, exitCode, stdout } = execution;
  logger.debug(`${command} audit output received (${stdout.length} bytes).`);

  if (exitCode === undefined || !ADVISORY_EXIT_CODES.includes(exitCode)) {
    return incompleteOutcome(
      'unexpected-exit',
      `${command} audit exited with an unexpected code (${exitCode ?? 'none'}).`,
    );
  }

  const output = stdout.trim();
  if (output === '') {
    return incompleteOutcome('empty-output', `${command} audit produced no output.`);
  }

  try {
    return { kind: 'json', json: JSON.parse(output) as unknown, exitCode };
  }
  catch (err) {
    return incompleteOutcome(
      'malformed-json',
      `${command} audit output is not valid JSON: ${describeError(err)}`,
    );
  }
}

/** Builds the clean or advisories outcome for a recognized schema from its readable advisories. */
export function buildRecognizedOutcome(
  schema: AuditSchemaId,
  manager: AuditPackageManager,
  exitCode: number,
  advisories: Iterable<AuditAdvisory>,
): AuditCleanOutcome | AuditAdvisoriesOutcome {
  const sorted = [...advisories].sort((left, right) => compareCodeUnits(left.identity, right.identity));
  const vulnerabilities = new Map<string, AuditSeverity>();
  for (const advisory of sorted) {
    const current = vulnerabilities.get(advisory.packageName);
    vulnerabilities.set(
      advisory.packageName,
      current === undefined ? advisory.severity : mergeSeverity(current, advisory.severity),
    );
  }
  logger.info(`Audit complete: ${vulnerabilities.size} vulnerable package(s).`);
  if (vulnerabilities.size === 0) {
    return { kind: 'clean', schema, manager, exitCode, vulnerabilities, advisories: sorted, total: 0 };
  }
  return {
    kind: 'advisories',
    schema,
    manager,
    exitCode,
    vulnerabilities,
    advisories: sorted,
    total: vulnerabilities.size,
  };
}

/**
 * Narrows a recognized outcome to the result shape. Incomplete and error outcomes
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

function managerForSchema(schema: AuditSchemaId): AuditPackageManager {
  if (schema === 'npm-v1-advisories' || schema === 'npm-v2-vulnerabilities') {
    return 'npm';
  }
  if (schema.startsWith('yarn-')) {
    return 'yarn';
  }
  return 'bun';
}