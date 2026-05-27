import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from './logger';

const execFileAsync = promisify(execFile);

export type AuditSeverity = 'critical' | 'high' | 'moderate' | 'low' | 'info';

export interface AuditResult {
  vulnerabilities: Map<string, AuditSeverity>;
  total: number;
}

const severityOrder: AuditSeverity[] = ['critical', 'high', 'moderate', 'low', 'info'];

interface NpmAuditJson {
  vulnerabilities?: Record<string, { severity?: string }>;
}

export async function runNpmAudit(cwd: string): Promise<AuditResult> {
  logger.info(`Running npm audit in ${cwd}.`);
  try {
    const result = await execFileAsync('npm', ['audit', '--json'], { cwd }) as { stdout: string } | string;
    return parseAuditJson(typeof result === 'string' ? result : result.stdout);
  }
  catch (err) {
    const stdout = getExecStdout(err);
    if (stdout !== undefined) {
      return parseAuditJson(stdout);
    }
    logger.error('npm audit failed.', err);
    throw err;
  }
}

function parseAuditJson(output: string): AuditResult {
  const json = JSON.parse(output) as NpmAuditJson;
  const vulnerabilities = new Map<string, AuditSeverity>();
  for (const [name, info] of Object.entries(json.vulnerabilities ?? {})) {
    const severity = parseSeverity(info.severity);
    if (severity === undefined) {
      continue;
    }
    const existing = vulnerabilities.get(name);
    vulnerabilities.set(name, existing === undefined ? severity : mergeSeverity(existing, severity));
  }
  logger.info(`Audit complete: ${vulnerabilities.size} vulnerable package(s).`);
  return { vulnerabilities, total: vulnerabilities.size };
}

function mergeSeverity(left: AuditSeverity, right: AuditSeverity): AuditSeverity {
  return severityOrder.indexOf(left) <= severityOrder.indexOf(right) ? left : right;
}

function parseSeverity(value: string | undefined): AuditSeverity | undefined {
  return severityOrder.find(severity => severity === value);
}

function getExecStdout(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('stdout' in err)) {
    return undefined;
  }
  const { stdout } = err as { stdout?: unknown };
  return typeof stdout === 'string' ? stdout : undefined;
}