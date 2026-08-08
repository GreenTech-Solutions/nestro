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
import { resolveYarnFamily } from './yarnFamily';
import type { YarnFamily } from './yarnFamily';

const execFileAsync = promisify(execFile);
const classicSchema = 'yarn-classic-audit' as const;
const modernSchema = 'yarn-modern-npm-audit' as const;
const severityBits: Readonly<Record<AuditSeverity, number>> = {
  info: 1,
  low: 2,
  moderate: 4,
  high: 8,
  critical: 16,
};

const classicArgs = ['audit', '--json'] as const;
const modernArgs = ['npm', 'audit', '--all', '--recursive', '--json'] as const;

interface ClassicSummary {
  mask: number;
  counts: Record<AuditSeverity, number>;
}

interface ParsedLineFailure {
  reason: 'malformed-json' | 'unrecognized-schema';
  detail: string;
}

interface ModernAdvisory {
  packageName: string;
  severity: AuditSeverity;
}

interface YarnAuditExecution extends AuditExecution {
  stderr?: string;
}

/** Resolves the Yarn family lazily, runs its exact command, and returns only recognized results. */
export async function runYarnAudit(cwd: string): Promise<AuditResult> {
  return toAuditResult(await runYarnAuditOutcome(cwd));
}

/** Runs the family-specific Yarn audit command without ever guessing Classic behavior. */
export async function runYarnAuditOutcome(cwd: string): Promise<AuditOutcome> {
  const { family, source } = await resolveYarnFamily(cwd);
  if (family === 'unknown') {
    return incompleteOutcome(
      'unknown-yarn-family',
      `Yarn audit family could not be identified in ${cwd} (${source}); audit was not run.`,
    );
  }

  const args = family === 'classic' ? classicArgs : modernArgs;
  logger.info(`Running Yarn ${family} audit in ${cwd}.`);
  try {
    const result = await execFileAsync('yarn', [...args], { cwd }) as { stderr: string; stdout: string } | string;
    const stdout = typeof result === 'string' ? result : result.stdout;
    const stderr = typeof result === 'string' ? '' : result.stderr;
    return parseYarnAuditOutcome(family, { command: 'yarn', stderr, stdout, exitCode: 0 });
  }
  catch (err) {
    const exitCode = getExecExitCode(err);
    if (exitCode !== undefined) {
      return parseYarnAuditOutcome(family, {
        command: 'yarn',
        stderr: getExecStderr(err) ?? '',
        stdout: getExecStdout(err) ?? '',
        exitCode,
      });
    }
    const detail = `yarn ${family} audit could not run: ${describeError(err)}`;
    logger.error(`yarn ${family} audit could not run.`);
    return {
      kind: 'error',
      reason: readErrorCode(err) === 'ENOENT' ? 'command-not-found' : 'process-failed',
      detail,
    };
  }
}

/** Parses only the schema documented for the family selected before command execution. */
export function parseYarnAuditOutcome(family: YarnFamily, execution: YarnAuditExecution): AuditOutcome {
  logger.debug(`Raw Yarn ${family} audit output snippet: ${execution.stdout.slice(0, 200)}`);
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

  const vulnerabilities = new Map<string, AuditSeverity>();
  const observedCounts = emptySeverityCounts();
  let summary: ClassicSummary | undefined;

  for (const [index, line] of lines.entries()) {
    const parsed = parseJsonLine(line, 'Yarn Classic');
    if (isLineFailure(parsed)) {
      return incompleteOutcome(parsed.reason, parsed.detail);
    }
    if (!isPlainObject(parsed) || typeof parsed.type !== 'string') {
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
    mergeFinding(vulnerabilities, advisory.packageName, advisory.severity);
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
  return recognizedOutcome(classicSchema, execution.exitCode, vulnerabilities);
}

function parseModernOutcome(execution: YarnAuditExecution): AuditOutcome {
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
    return recognizedOutcome(modernSchema, 0, new Map());
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

  const vulnerabilities = new Map<string, AuditSeverity>();
  for (const line of lines) {
    const parsed = parseJsonLine(line, 'Yarn Modern');
    if (isLineFailure(parsed)) {
      return incompleteOutcome(parsed.reason, parsed.detail);
    }
    const advisory = parseModernAdvisory(parsed);
    if (advisory === undefined) {
      return incompleteOutcome('unrecognized-schema', 'Yarn Modern audit contains an unknown tree record.');
    }
    mergeFinding(vulnerabilities, advisory.packageName, advisory.severity);
  }

  return recognizedOutcome(modernSchema, 1, vulnerabilities);
}

function parseClassicAdvisory(record: Record<string, unknown>): ModernAdvisory | undefined {
  if (!isPlainObject(record.data)
    || !isPlainObject(record.data.resolution)
    || !isPlainObject(record.data.advisory)) {
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
  return { packageName, severity };
}

function parseClassicSummary(record: Record<string, unknown>): ClassicSummary | undefined {
  const data = record.data;
  if (!isPlainObject(data)) {
    return undefined;
  }
  const vulnerabilitySummary = data.vulnerabilities;
  if (!isPlainObject(vulnerabilitySummary)) {
    return undefined;
  }

  const counterNames = ['dependencies', 'devDependencies', 'optionalDependencies', 'totalDependencies'] as const;
  if (counterNames.some(name => !isNonNegativeInteger(data[name]))) {
    return undefined;
  }

  let mask = 0;
  const counts = emptySeverityCounts();
  for (const [severity, bit] of Object.entries(severityBits) as [AuditSeverity, number][]) {
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

function parseModernAdvisory(value: unknown): ModernAdvisory | undefined {
  if (!isPlainObject(value)
    || !isPlainObject(value.children)) {
    return undefined;
  }
  const packageName = readRequiredString(value.value);
  const id = value.children.ID;
  const severity = parseSeverity(readRequiredString(value.children.Severity));
  const url = value.children.URL;
  if (packageName === undefined
    || !isAdvisoryId(id)
    || readRequiredString(value.children.Issue) === undefined
    || (url !== undefined && readRequiredString(url) === undefined)
    || severity === undefined
    || readRequiredString(value.children['Vulnerable Versions']) === undefined
    || !isNonEmptyStringArray(value.children['Tree Versions'])
    || !isNonEmptyStringArray(value.children.Dependents)) {
    return undefined;
  }
  return { packageName, severity };
}

function parseJsonLine(line: string, familyLabel: string): unknown | ParsedLineFailure {
  try {
    return JSON.parse(line) as unknown;
  }
  catch (err) {
    return {
      reason: 'malformed-json',
      detail: `${familyLabel} audit contains malformed JSON: ${describeError(err)}`,
    };
  }
}

function recognizedOutcome(
  schema: typeof classicSchema | typeof modernSchema,
  exitCode: number,
  vulnerabilities: Map<string, AuditSeverity>,
): AuditOutcome {
  if (vulnerabilities.size === 0) {
    logger.info('Audit complete: 0 vulnerable package(s).');
    return { kind: 'clean', schema, exitCode, vulnerabilities, total: 0 };
  }
  logger.info(`Audit complete: ${vulnerabilities.size} vulnerable package(s).`);
  return {
    kind: 'advisories',
    schema,
    exitCode,
    vulnerabilities,
    total: vulnerabilities.size,
  };
}

function mergeFinding(
  vulnerabilities: Map<string, AuditSeverity>,
  packageName: string,
  severity: AuditSeverity,
): void {
  const existing = vulnerabilities.get(packageName);
  vulnerabilities.set(packageName, existing === undefined ? severity : mergeSeverity(existing, severity));
}

function emptySeverityCounts(): Record<AuditSeverity, number> {
  return { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
}

function sameSeverityCounts(
  left: Record<AuditSeverity, number>,
  right: Record<AuditSeverity, number>,
): boolean {
  return (Object.keys(severityBits) as AuditSeverity[])
    .every(severity => left[severity] === right[severity]);
}

function nonEmptyLines(output: string): string[] {
  return output.split('\n').filter(line => line.trim() !== '');
}

function isLineFailure(value: unknown | ParsedLineFailure): value is ParsedLineFailure {
  return isPlainObject(value)
    && (value.reason === 'malformed-json' || value.reason === 'unrecognized-schema')
    && typeof value.detail === 'string';
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

function isAdvisoryId(value: unknown): boolean {
  return typeof value === 'number' ? Number.isFinite(value) : readRequiredString(value) !== undefined;
}

function isNonEmptyStringArray(value: unknown): boolean {
  return Array.isArray(value)
    && value.length > 0
    && value.every(entry => readRequiredString(entry) !== undefined);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function readErrorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
}

function getExecStderr(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  const { stderr } = err as { stderr?: unknown };
  return typeof stderr === 'string' ? stderr : undefined;
}

function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split(/\r?\n/, 1)[0];
}