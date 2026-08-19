import {
  AUDIT_PROCESS_MAX_BUFFER_BYTES,
  AUDIT_PROCESS_TIMEOUT_MS,
  describeBoundedProcessFailure,
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
import { runBoundedProcess } from './processRunner';
import { createAuditAdvisory, mergeAuditAdvisory } from './auditReport';
import type { AuditAdvisory } from './auditReport';

const bunSchema = 'bun-bulk-advisory' as const;
const compatibleExitCodes: readonly number[] = [0, 1];

/** Runs Bun's raw-registry JSON audit contract in one package root. */
export async function runBunAudit(cwd: string, signal?: AbortSignal): Promise<AuditResult> {
  logger.info('Running bun audit.');
  return toAuditResult(await runBunAuditOutcome(cwd, signal));
}

/**
 * Runs `bun audit --json`, bounded by a timeout, output cap and optional cancellation
 * `signal` (`ARC-07`), and preserves advisory exit 1 for the Bun parser.
 */
export async function runBunAuditOutcome(cwd: string, signal?: AbortSignal): Promise<AuditOutcome> {
  const outcome = await runBoundedProcess('bun', ['audit', '--json'], {
    cwd,
    timeoutMs: AUDIT_PROCESS_TIMEOUT_MS,
    maxBufferBytes: AUDIT_PROCESS_MAX_BUFFER_BYTES,
    signal,
  });
  if (outcome.kind !== 'exit') {
    return describeBoundedProcessFailure('bun', outcome);
  }
  return parseBunAuditOutcome({ command: 'bun', stdout: outcome.stdout, exitCode: outcome.exitCode });
}

/**
 * Parses Bun's raw npm Bulk Advisory response. Bun 1.3.x pairs `{}` with exit 0 and
 * a non-empty package-to-advisory-array object with exit 1. Any partial or unfamiliar
 * entry invalidates the complete payload so schema evolution cannot silently hide a
 * finding.
 */
export function parseBunAuditOutcome(execution: AuditExecution): AuditOutcome {
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

  const advisories = parseBulkAdvisories(json);
  if (advisories === undefined) {
    return incompleteOutcome(
      'unrecognized-schema',
      `${command} audit output does not match the Bun bulk advisory schema.`,
    );
  }

  const vulnerabilities = new Map<string, AuditSeverity>();
  for (const advisory of advisories.values()) {
    const current = vulnerabilities.get(advisory.packageName);
    vulnerabilities.set(advisory.packageName, current === undefined ? advisory.severity : mergeSeverity(current, advisory.severity));
  }
  const structuredAdvisories = [...advisories.values()].sort((left, right) => left.identity.localeCompare(right.identity));
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
      manager: 'bun',
      exitCode,
      vulnerabilities,
      advisories: structuredAdvisories,
      total: 0,
    };
  }

  logger.info(`Audit complete: ${vulnerabilities.size} vulnerable package(s).`);
  return {
    kind: 'advisories',
    schema: bunSchema,
    manager: 'bun',
    exitCode,
    vulnerabilities,
    advisories: structuredAdvisories,
    total: vulnerabilities.size,
  };
}

function parseBulkAdvisories(json: unknown): Map<string, AuditAdvisory> | undefined {
  if (!isPlainObject(json)) {
    return undefined;
  }

  const packages = Object.entries(json);
  const advisories = new Map<string, AuditAdvisory>();

  for (const [packageName, entries] of packages) {
    if (packageName.trim() === '' || !Array.isArray(entries) || entries.length === 0) {
      return undefined;
    }

    for (const entry of entries) {
      const advisory = parseBulkAdvisory(packageName, entry);
      if (advisory === undefined) {
        return undefined;
      }
      mergeAuditAdvisory(advisories, advisory);
    }
  }

  return advisories;
}

function parseBulkAdvisory(packageName: string, value: unknown): AuditAdvisory | undefined {
  if (!isPlainObject(value)
    || !isAdvisoryId(value.id)
    || readRequiredString(value.url) === undefined
    || readRequiredString(value.title) === undefined
    || readRequiredString(value.vulnerable_versions) === undefined
    || !isOptionalCwe(value.cwe)
    || !isOptionalCvss(value.cvss)) {
    return undefined;
  }

  const severity = parseSeverity(readRequiredString(value.severity));
  if (severity === undefined) {
    return undefined;
  }
  return createAuditAdvisory({
    packageName,
    severity,
    manager: 'bun',
    schema: bunSchema,
    advisoryId: String(value.id),
    source: readOptionalIdentity(value.source),
    title: readRequiredString(value.title),
    url: readRequiredString(value.url),
    affectedRange: readRequiredString(value.vulnerable_versions),
    attribution: 'unknown',
    via: [],
    fixAvailable: parseFixAvailable(value.fixAvailable ?? value.fix_available),
  });
}

function readOptionalIdentity(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : readRequiredString(value);
}

function parseFixAvailable(value: unknown): boolean | { name?: string; version?: string; isSemVerMajor?: boolean } | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (!isPlainObject(value)) {
    return undefined;
  }
  const name = readRequiredString(value.name);
  const version = readRequiredString(value.version);
  const isSemVerMajor = typeof value.isSemVerMajor === 'boolean' ? value.isSemVerMajor : undefined;
  return name === undefined && version === undefined && isSemVerMajor === undefined
    ? undefined
    : { name, version, isSemVerMajor };
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRequiredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}