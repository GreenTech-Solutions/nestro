import { isAdvisoryId, parseFixAvailable } from './audit/fields';
import {
  buildRecognizedOutcome,
  incompleteOutcome,
  runAuditCommand,
  toAuditResult,
} from './audit/outcome';
import type { AuditErrorOutcome, AuditExecution, AuditOutcome, AuditResult } from './audit/outcome';
import {
  emptySeverityCounts,
  parseSeverity,
  YARN_CLASSIC_SEVERITY_BITS,
} from './audit/types';
import type { AuditSeverity } from './audit/types';
import { createAuditAdvisory, inferPathAttribution, mergeAuditAdvisory } from './auditReport';
import type { AuditAdvisory } from './auditReport';
import { logger } from './logger';
import { resolveYarnFamily } from './yarnFamily';
import type { YarnFamily } from './yarnFamily';
import { describeError, isRecord, PACKAGE_MANAGERS, readRequiredString, YARN_DIALECTS } from '../shared';

const classicSchema = 'yarn-classic-audit' as const;
const modernSchema = 'yarn-modern-npm-audit' as const;

interface ClassicSummary {
  mask: number;
  counts: Record<AuditSeverity, number>;
}

interface ParsedLineFailure {
  reason: 'malformed-json' | 'unrecognized-schema';
  detail: string;
}

/** Resolves the Yarn family lazily, runs its exact command, and returns only recognized results. */
export async function runYarnAudit(cwd: string, signal?: AbortSignal): Promise<AuditResult> {
  return toAuditResult(await runYarnAuditOutcome(cwd, signal));
}

/**
 * Runs the family-specific Yarn audit command without ever guessing Classic behavior.
 * Bounded by a timeout, output cap and optional cancellation `signal`; a process that
 * was terminated before it exited is always incomplete or error.
 */
export async function runYarnAuditOutcome(cwd: string, signal?: AbortSignal): Promise<AuditOutcome> {
  const { family, source } = await resolveYarnFamily(cwd);
  if (family === 'unknown') {
    return incompleteOutcome(
      'unknown-yarn-family',
      `Yarn audit family could not be identified (${source}); audit was not run.`,
    );
  }

  logger.info(`Running Yarn ${family} audit.`);
  return runAuditCommand(
    { command: PACKAGE_MANAGERS.yarn.bin, args: YARN_DIALECTS[family].audit, cwd, signal },
    execution => parseYarnAuditOutcome(family, execution),
    // The family-agnostic message can only say "yarn could not run…"; this names the family
    // and keeps the first line, and is this event's one log call.
    (outcome): AuditErrorOutcome => {
      const detail = `yarn ${family === 'classic' ? 'classic' : 'berry'} audit could not run: ${firstErrorLine(outcome.message)}`;
      logger.error('Yarn audit process could not start; see the security audit report for redacted details.');
      return { kind: 'error', reason: outcome.reason, detail };
    },
  );
}

/** Parses only the schema documented for the family selected before command execution. */
export function parseYarnAuditOutcome(family: YarnFamily, execution: AuditExecution): AuditOutcome {
  logger.debug(`Yarn ${family} audit output received (${execution.stdout.length} bytes).`);
  if (family === 'classic') {
    return parseClassicOutcome(execution);
  }
  if (family === 'modern') {
    return parseModernOutcome(execution);
  }
  return incompleteOutcome(
    'unknown-yarn-family',
    'Yarn audit output cannot be interpreted without a recognized Yarn family.',
  );
}

function parseClassicOutcome(execution: AuditExecution): AuditOutcome {
  const lines = nonEmptyLines(execution.stdout);
  if (lines.length === 0) {
    return incompleteOutcome('empty-output', 'Yarn Classic audit produced no output.');
  }

  const advisories = new Map<string, AuditAdvisory>();
  const observedCounts = emptySeverityCounts();
  let summary: ClassicSummary | undefined;

  for (const [index, line] of lines.entries()) {
    const parsed = parseJsonLine(line, 'Yarn Classic');
    if (isLineFailure(parsed)) {
      return incompleteOutcome(parsed.reason, parsed.detail);
    }
    if (!isRecord(parsed) || typeof parsed.type !== 'string') {
      return incompleteOutcome('unrecognized-schema', 'Yarn Classic audit contains an unknown record.');
    }

    if (parsed.type === 'auditSummary') {
      if (summary !== undefined || index !== lines.length - 1) {
        return incompleteOutcome(
          'unrecognized-schema',
          'Yarn Classic audit must contain exactly one final auditSummary record.',
        );
      }
      summary = parseClassicSummary(parsed);
      if (summary === undefined) {
        return incompleteOutcome('unrecognized-schema', 'Yarn Classic auditSummary is malformed.');
      }
      continue;
    }

    if (parsed.type !== 'auditAdvisory' || summary !== undefined) {
      return incompleteOutcome('unrecognized-schema', 'Yarn Classic audit contains an unknown record.');
    }
    const advisory = parseClassicAdvisory(parsed);
    if (advisory === undefined) {
      return incompleteOutcome('unrecognized-schema', 'Yarn Classic auditAdvisory is malformed.');
    }
    mergeAuditAdvisory(advisories, advisory);
    observedCounts[advisory.severity] += 1;
  }

  if (summary === undefined) {
    return incompleteOutcome('unrecognized-schema', 'Yarn Classic audit is missing its final auditSummary.');
  }
  if (!sameSeverityCounts(summary.counts, observedCounts)) {
    return incompleteOutcome(
      'summary-mismatch',
      'Yarn Classic auditSummary does not match the readable advisory severities.',
    );
  }
  if (execution.exitCode !== summary.mask) {
    return incompleteOutcome(
      'unexpected-exit',
      `Yarn Classic audit severity mask requires exit ${summary.mask} but received ${execution.exitCode ?? 'none'}.`,
    );
  }
  return buildRecognizedOutcome(classicSchema, 'yarn', execution.exitCode, advisories.values());
}

function parseModernOutcome(execution: AuditExecution): AuditOutcome {
  if ((execution.stderr ?? '').trim() !== '') {
    return incompleteOutcome(
      'unrecognized-schema',
      'Yarn Modern audit produced unexpected stderr output.',
    );
  }
  if (execution.stdout === '') {
    if (execution.exitCode !== 0) {
      return incompleteOutcome('empty-output', 'Yarn Modern audit produced no advisory output.');
    }
    return buildRecognizedOutcome(modernSchema, 'yarn', 0, []);
  }

  if (execution.stdout.trim() === '') {
    return incompleteOutcome(
      'unrecognized-schema',
      'Yarn Modern clean output must be exactly empty.',
    );
  }

  if (execution.exitCode !== 1) {
    return incompleteOutcome(
      'unexpected-exit',
      `Yarn Modern advisory output requires exit 1 but received ${execution.exitCode ?? 'none'}.`,
    );
  }
  const lines = nonEmptyLines(execution.stdout);
  if (lines.length === 0) {
    return incompleteOutcome('unrecognized-schema', 'Yarn Modern clean output must be exactly empty.');
  }

  const advisories = new Map<string, AuditAdvisory>();
  for (const line of lines) {
    const parsed = parseJsonLine(line, 'Yarn Modern');
    if (isLineFailure(parsed)) {
      return incompleteOutcome(parsed.reason, parsed.detail);
    }
    const advisory = parseModernAdvisory(parsed);
    if (advisory === undefined) {
      return incompleteOutcome('unrecognized-schema', 'Yarn Modern audit contains an unknown tree record.');
    }
    mergeAuditAdvisory(advisories, advisory);
  }

  return buildRecognizedOutcome(modernSchema, 'yarn', 1, advisories.values());
}

function parseClassicAdvisory(record: Record<string, unknown>): AuditAdvisory | undefined {
  if (!isRecord(record.data)
    || !isRecord(record.data.resolution)
    || !isRecord(record.data.advisory)) {
    return undefined;
  }

  const advisoryId = record.data.advisory.id;
  const resolution = record.data.resolution;
  const resolutionId = resolution.id;
  const packageName = readRequiredString(record.data.advisory.module_name);
  const severity = parseSeverity(readRequiredString(record.data.advisory.severity));
  if (!isAdvisoryId(advisoryId)
    || !isAdvisoryId(resolutionId)
    || String(advisoryId) !== String(resolutionId)
    || readRequiredString(resolution.path) === undefined
    || typeof resolution.dev !== 'boolean'
    || typeof resolution.optional !== 'boolean'
    || typeof resolution.bundled !== 'boolean'
    || packageName === undefined
    || severity === undefined) {
    return undefined;
  }
  const advisory = record.data.advisory;
  const resolutionPath = readRequiredString(resolution.path);
  const resolvedVersion = readRequiredString(resolution.version) ?? readRequiredString(advisory.version);
  return createAuditAdvisory({
    packageName,
    severity,
    manager: 'yarn',
    schema: classicSchema,
    advisoryId: String(advisoryId),
    source: readRequiredString(advisory.source),
    title: readRequiredString(advisory.title),
    url: readRequiredString(advisory.url),
    affectedRange: readRequiredString(advisory.vulnerable_versions)
      ?? readRequiredString(advisory.range),
    resolvedPaths: resolutionPath === undefined ? [] : [resolutionPath],
    resolvedVersions: resolvedVersion === undefined ? [] : [resolvedVersion],
    attribution: inferPathAttribution(packageName, resolutionPath === undefined ? [] : [resolutionPath]),
    via: [],
    fixAvailable: parseFixAvailable(advisory.fixAvailable ?? advisory.fix_available),
  });
}

function parseClassicSummary(record: Record<string, unknown>): ClassicSummary | undefined {
  const data = record.data;
  if (!isRecord(data)) {
    return undefined;
  }
  const vulnerabilitySummary = data.vulnerabilities;
  if (!isRecord(vulnerabilitySummary)) {
    return undefined;
  }

  const counterNames = ['dependencies', 'devDependencies', 'optionalDependencies', 'totalDependencies'] as const;
  if (counterNames.some(name => !isNonNegativeInteger(data[name]))) {
    return undefined;
  }

  let mask = 0;
  const counts = emptySeverityCounts();
  for (const [severity, bit] of Object.entries(YARN_CLASSIC_SEVERITY_BITS) as [AuditSeverity, number][]) {
    const count = vulnerabilitySummary[severity];
    if (!isNonNegativeInteger(count)) {
      return undefined;
    }
    counts[severity] = count;
    if (count > 0) {
      mask |= bit;
    }
  }
  return { mask, counts };
}

function parseModernAdvisory(value: unknown): AuditAdvisory | undefined {
  if (!isRecord(value)
    || !isRecord(value.children)) {
    return undefined;
  }
  const packageName = readRequiredString(value.value);
  const id = value.children.ID;
  const severity = parseSeverity(readRequiredString(value.children.Severity));
  const url = value.children.URL;
  const issue = readRequiredString(value.children.Issue);
  const affectedRange = readRequiredString(value.children['Vulnerable Versions']);
  const resolvedVersions = readNonEmptyStringArray(value.children['Tree Versions']);
  const dependents = readNonEmptyStringArray(value.children.Dependents);
  if (packageName === undefined
    || !isAdvisoryId(id)
    || issue === undefined
    || (url !== undefined && readRequiredString(url) === undefined)
    || severity === undefined
    || affectedRange === undefined
    || resolvedVersions === undefined
    || dependents === undefined) {
    return undefined;
  }
  return createAuditAdvisory({
    packageName,
    severity,
    manager: 'yarn',
    schema: modernSchema,
    advisoryId: String(id),
    title: issue,
    url: readRequiredString(url),
    affectedRange,
    // Berry's Dependents values are virtual locators (for example workspace:.),
    // not filesystem resolution paths. Keep them as provenance only so they can
    // never accidentally badge a manifest row.
    resolvedPaths: [],
    resolvedVersions,
    attribution: 'unknown',
    via: dependents.map(identity => ({ identity })),
    fixAvailable: parseFixAvailable(value.children.Fix ?? value.children['Fix Available']),
  });
}

function parseJsonLine(line: string, familyLabel: string): unknown | ParsedLineFailure {
  try {
    return JSON.parse(line) as unknown;
  }
  catch (err) {
    return {
      reason: 'malformed-json',
      detail: `${familyLabel} audit contains malformed JSON: ${firstErrorLine(err)}`,
    };
  }
}

function sameSeverityCounts(
  left: Record<AuditSeverity, number>,
  right: Record<AuditSeverity, number>,
): boolean {
  return (Object.keys(YARN_CLASSIC_SEVERITY_BITS) as AuditSeverity[])
    .every(severity => left[severity] === right[severity]);
}

function nonEmptyLines(output: string): string[] {
  return output.split('\n').filter(line => line.trim() !== '');
}

function isLineFailure(value: unknown | ParsedLineFailure): value is ParsedLineFailure {
  return isRecord(value)
    && (value.reason === 'malformed-json' || value.reason === 'unrecognized-schema')
    && typeof value.detail === 'string';
}

function isNonEmptyStringArray(value: unknown): boolean {
  return Array.isArray(value)
    && value.length > 0
    && value.every(entry => readRequiredString(entry) !== undefined);
}

function readNonEmptyStringArray(value: unknown): string[] | undefined {
  return isNonEmptyStringArray(value)
    ? (value as unknown[]).map(entry => String(entry))
    : undefined;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function firstErrorLine(err: unknown): string {
  return describeError(err).split(/\r?\n/, 1)[0];
}