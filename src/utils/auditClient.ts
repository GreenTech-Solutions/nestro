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
  advisories?: Record<string, { module_name?: string; severity?: string }>;
}

export async function runNpmAudit(cwd: string): Promise<AuditResult> {
  logger.info(`Running npm audit in ${cwd}.`);
  return await runAuditCommand('npm', ['audit', '--json'], cwd);
}

export async function runPackageAudit(packageManager: string, cwd: string): Promise<AuditResult> {
  logger.info(`Running ${packageManager} audit in ${cwd}.`);
  return await runAuditCommand(packageManager, ['audit', '--json'], cwd);
}

async function runAuditCommand(command: string, args: readonly string[], cwd: string): Promise<AuditResult> {
  try {
    const result = await execFileAsync(command, [...args], { cwd }) as { stdout: string } | string;
    return parseAuditJson(typeof result === 'string' ? result : result.stdout);
  }
  catch (err) {
    const stdout = getExecStdout(err);
    if (stdout !== undefined) {
      return parseAuditJson(stdout);
    }
    logger.error(`${command} audit failed.`, err);
    throw err;
  }
}

function parseAuditJson(output: string): AuditResult {
  logger.debug(`Raw audit output snippet: ${output.slice(0, 200)}`);
  const json = JSON.parse(output) as NpmAuditJson;
  const vulnerabilities = new Map<string, AuditSeverity>();

  if (json.vulnerabilities) {
    for (const [name, info] of Object.entries(json.vulnerabilities)) {
      const severity = parseSeverity(info.severity);
      if (severity === undefined) {
        continue;
      }
      const existing = vulnerabilities.get(name);
      vulnerabilities.set(name, existing === undefined ? severity : mergeSeverity(existing, severity));
    }
  }
  else if (json.advisories) {
    for (const info of Object.values(json.advisories)) {
      if (!info.module_name) {
        continue;
      }
      const severity = parseSeverity(info.severity);
      if (severity === undefined) {
        continue;
      }
      const existing = vulnerabilities.get(info.module_name);
      vulnerabilities.set(info.module_name, existing === undefined ? severity : mergeSeverity(existing, severity));
    }
  }
  else {
    logger.warn('Unrecognised audit JSON format');
  }

  logger.info(`Audit complete: ${vulnerabilities.size} vulnerable package(s).`);
  return { vulnerabilities, total: vulnerabilities.size };
}

export function mergeSeverity(left: AuditSeverity, right: AuditSeverity): AuditSeverity {
  return severityOrder.indexOf(left) <= severityOrder.indexOf(right) ? left : right;
}

export function parseSeverity(value: string | undefined): AuditSeverity | undefined {
  return severityOrder.find(severity => severity === value);
}

export function getExecStdout(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('stdout' in err)) {
    return undefined;
  }
  const { stdout } = err as { stdout?: unknown };
  return typeof stdout === 'string' ? stdout : undefined;
}