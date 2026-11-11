import { isAdvisoryId, parseFixAvailable } from './audit/fields';
import { buildRecognizedOutcome, incompleteOutcome } from './audit/outcome';
import type { AuditExecution, AuditOutcome } from './audit/outcome';
import {
  emptySeverityCounts,
  parseSeverity,
  YARN_CLASSIC_SEVERITY_BITS,
} from './audit/types';
import type { AuditSeverity } from './audit/types';
import { createAuditAdvisory, inferPathAttribution, mergeAuditAdvisory } from './auditReport';
import type { AuditAdvisory } from './auditReport';
import { isRecord, readRequiredString } from '../shared';
import { isLineFailure, nonEmptyLines, parseJsonLine } from './yarnAuditParsing';

const classicSchema = 'yarn-classic-audit' as const;

interface ClassicSummary {
  mask: number;
  counts: Record<AuditSeverity, number>;
}

export function parseClassicOutcome(execution: AuditExecution): AuditOutcome {
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

  return buildClassicOutcome(execution, summary, advisories, observedCounts);
}

function buildClassicOutcome(
  execution: AuditExecution,
  summary: ClassicSummary | undefined,
  advisories: Map<string, AuditAdvisory>,
  observedCounts: Record<AuditSeverity, number>,
): AuditOutcome {
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

function sameSeverityCounts(
  left: Record<AuditSeverity, number>,
  right: Record<AuditSeverity, number>,
): boolean {
  return (Object.keys(YARN_CLASSIC_SEVERITY_BITS) as AuditSeverity[])
    .every(severity => left[severity] === right[severity]);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}