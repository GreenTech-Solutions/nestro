import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  getExecExitCode,
  getExecStdout,
  mergeSeverity,
  parseSeverity,
  toAuditResult,
} from './auditClient';
import type {
  AuditExecution,
  AuditIncompleteOutcome,
  AuditIncompleteReason,
  AuditOutcome,
  AuditResult,
  AuditSeverity,
} from './auditClient';
import { logger } from './logger';

const execFileAsync = promisify(execFile);
const bunSchema = 'bun-bulk-advisory' as const;
const compatibleExitCodes: readonly number[] = [0, 1];

/** Runs Bun's raw-registry JSON audit contract in one package root. */
export async function runBunAudit(cwd: string): Promise<AuditResult> {
  logger.info(`Running bun audit in ${cwd}.`);
  return toAuditResult(await runBunAuditOutcome(cwd));
}

/** Runs `bun audit --json` and preserves advisory exit 1 for the Bun parser. */
export async function runBunAuditOutcome(cwd: string): Promise<AuditOutcome> {
  try {
    const result = await execFileAsync('bun', ['audit', '--json'], { cwd }) as { stdout: string } | string;
    const stdout = typeof result === 'string' ? result : result.stdout;
    return parseBunAuditOutcome({ command: 'bun', stdout, exitCode: 0 });
  }
  catch (err) {
    const exitCode = getExecExitCode(err);
    if (exitCode !== undefined) {
      return parseBunAuditOutcome({ command: 'bun', stdout: getExecStdout(err) ?? '', exitCode });
    }
    const detail = `bun audit could not run: ${describeError(err)}`;
    logger.error(detail, err);
    return {
      kind: 'error',
      reason: isCommandNotFound(err) ? 'command-not-found' : 'process-failed',
      detail,
    };
  }
}

/**
 * Parses Bun's raw npm Bulk Advisory response. Bun 1.3.x pairs `{}` with exit 0 and
 * a non-empty package-to-advisory-array object with exit 1. Any partial or unfamiliar
 * entry invalidates the complete payload so schema evolution cannot silently hide a
 * finding.
 */
export function parseBunAuditOutcome(execution: AuditExecution): AuditOutcome {
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

  const vulnerabilities = parseBulkAdvisories(json);
  if (vulnerabilities === undefined) {
    return incompleteOutcome(
      'unrecognized-schema',
      `${command} audit output does not match the Bun bulk advisory schema.`,
    );
  }

  const expectedExitCode = vulnerabilities.size === 0 ? 0 : 1;
  if (exitCode !== expectedExitCode) {
    return incompleteOutcome(
      'unexpected-exit',
      `${command} audit schema requires exit ${expectedExitCode} but received ${exitCode}.`,
    );
  }

  if (vulnerabilities.size === 0) {
    logger.info('Audit complete: 0 vulnerable package(s).');
    return {
      kind: 'clean',
      schema: bunSchema,
      exitCode,
      vulnerabilities,
      total: 0,
    };
  }

  logger.info(`Audit complete: ${vulnerabilities.size} vulnerable package(s).`);
  return {
    kind: 'advisories',
    schema: bunSchema,
    exitCode,
    vulnerabilities,
    total: vulnerabilities.size,
  };
}

function parseBulkAdvisories(json: unknown): Map<string, AuditSeverity> | undefined {
  if (!isPlainObject(json)) {
    return undefined;
  }

  const packages = Object.entries(json);
  const vulnerabilities = new Map<string, AuditSeverity>();

  for (const [packageName, entries] of packages) {
    if (packageName.trim() === '' || !Array.isArray(entries) || entries.length === 0) {
      return undefined;
    }

    let packageSeverity: AuditSeverity = 'info';
    for (const entry of entries) {
      const severity = parseBulkAdvisory(entry);
      if (severity === undefined) {
        return undefined;
      }
      packageSeverity = mergeSeverity(packageSeverity, severity);
    }

    vulnerabilities.set(packageName, packageSeverity);
  }

  return vulnerabilities;
}

function parseBulkAdvisory(value: unknown): AuditSeverity | undefined {
  if (!isPlainObject(value)
    || !isAdvisoryId(value.id)
    || readRequiredString(value.url) === undefined
    || readRequiredString(value.title) === undefined
    || readRequiredString(value.vulnerable_versions) === undefined
    || !isOptionalCwe(value.cwe)
    || !isOptionalCvss(value.cvss)) {
    return undefined;
  }

  return parseSeverity(readRequiredString(value.severity));
}

function isAdvisoryId(value: unknown): boolean {
  return typeof value === 'number'
    ? Number.isFinite(value)
    : readRequiredString(value) !== undefined;
}

function isOptionalCwe(value: unknown): boolean {
  return value === undefined
    || (Array.isArray(value) && value.every(entry => readRequiredString(entry) !== undefined));
}

function isOptionalCvss(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!isPlainObject(value) || typeof value.score !== 'number' || !Number.isFinite(value.score)) {
    return false;
  }
  return value.vectorString === null || readRequiredString(value.vectorString) !== undefined;
}

function incompleteOutcome(
  reason: AuditIncompleteReason,
  detail: string,
): AuditIncompleteOutcome {
  logger.warn(detail);
  return { kind: 'incomplete', reason, detail };
}

function isCommandNotFound(err: unknown): boolean {
  return readErrorCode(err) === 'ENOENT';
}

function readErrorCode(err: unknown): unknown {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  return (err as { code?: unknown }).code;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRequiredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}