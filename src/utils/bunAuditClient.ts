import { isAdvisoryId, parseFixAvailable } from './audit/fields';
import {
  buildRecognizedOutcome,
  incompleteOutcome,
  readAuditJsonDocument,
  runAuditCommand,
  toAuditResult,
} from './audit/outcome';
import type { AuditExecution, AuditOutcome, AuditResult } from './audit/outcome';
import { parseSeverity } from './audit/types';
import { createAuditAdvisory, mergeAuditAdvisory } from './auditReport';
import type { AuditAdvisory } from './auditReport';
import { logger } from './logger';
import { isRecord, PACKAGE_MANAGERS, readRequiredString } from '../shared';

const bunSchema = 'bun-bulk-advisory' as const;

/** Runs Bun's raw-registry JSON audit contract in one package root. */
export async function runBunAudit(cwd: string, signal?: AbortSignal): Promise<AuditResult> {
  logger.info('Running bun audit.');
  return toAuditResult(await runBunAuditOutcome(cwd, signal));
}

/**
 * Runs `bun audit --json`, bounded by a timeout, output cap and optional cancellation
 * `signal`, and preserves advisory exit 1 for the Bun parser.
 */
export function runBunAuditOutcome(cwd: string, signal?: AbortSignal): Promise<AuditOutcome> {
  return runAuditCommand(
    { command: PACKAGE_MANAGERS.bun.bin, args: PACKAGE_MANAGERS.bun.dialect.audit, cwd, signal },
    parseBunAuditOutcome,
  );
}

/**
 * Parses Bun's raw npm Bulk Advisory response: Bun 1.3.x pairs `{}` with exit 0 and a
 * non-empty package-to-advisory-array object with exit 1. Any partial or unfamiliar entry
 * invalidates the whole payload so schema evolution cannot silently hide a finding.
 */
export function parseBunAuditOutcome(execution: AuditExecution): AuditOutcome {
  const { command } = execution;
  const document = readAuditJsonDocument(execution);
  if (document.kind !== 'json') {
    return document;
  }

  const advisories = parseBulkAdvisories(document.json);
  if (advisories === undefined) {
    return incompleteOutcome(
      'unrecognized-schema',
      `${command} audit output does not match the Bun bulk advisory schema.`,
    );
  }

  const expectedExitCode = advisories.size === 0 ? 0 : 1;
  if (document.exitCode !== expectedExitCode) {
    return incompleteOutcome(
      'unexpected-exit',
      `${command} audit schema requires exit ${expectedExitCode} but received ${document.exitCode}.`,
    );
  }
  return buildRecognizedOutcome(bunSchema, 'bun', document.exitCode, advisories.values());
}

function parseBulkAdvisories(json: unknown): Map<string, AuditAdvisory> | undefined {
  if (!isRecord(json)) {
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
  if (!isRecord(value)
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

function isOptionalCwe(value: unknown): boolean {
  return value === undefined
    || (Array.isArray(value) && value.every(entry => readRequiredString(entry) !== undefined));
}

function isOptionalCvss(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!isRecord(value) || typeof value.score !== 'number' || !Number.isFinite(value.score)) {
    return false;
  }
  return value.vectorString === null || readRequiredString(value.vectorString) !== undefined;
}