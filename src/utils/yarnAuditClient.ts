import { isAdvisoryId, parseFixAvailable } from './audit/fields';
import {
  buildRecognizedOutcome,
  incompleteOutcome,
  runAuditCommand,
  toAuditResult,
} from './audit/outcome';
import type { AuditErrorOutcome, AuditExecution, AuditOutcome, AuditResult } from './audit/outcome';
import { parseSeverity } from './audit/types';
import { createAuditAdvisory, mergeAuditAdvisory } from './auditReport';
import type { AuditAdvisory } from './auditReport';
import { logger } from './logger';
import { resolveYarnFamily } from './yarnFamily';
import type { YarnFamily } from './yarnFamily';
import { isRecord, PACKAGE_MANAGERS, readRequiredString, YARN_DIALECTS } from '../shared';
import { parseClassicOutcome } from './yarnClassicAudit';
import { firstErrorLine, isLineFailure, nonEmptyLines, parseJsonLine } from './yarnAuditParsing';

const modernSchema = 'yarn-modern-npm-audit' as const;

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