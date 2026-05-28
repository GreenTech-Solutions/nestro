import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AuditSeverity, getExecStdout, mergeSeverity, parseSeverity } from '../utils/auditClient';
import { logger } from '../utils/logger';
import { Client, PackageTarget } from './Client';

const execFileAsync = promisify(execFile);

export class YarnClient extends Client {
  buildUpdateCommand(packages: readonly PackageTarget[]): string {
    return `yarn add ${this.formatPackageTargets(packages)}`;
  }

  buildInstallCommand(): string {
    return 'yarn install';
  }

  buildRemoveCommand(packages: readonly string[]): string {
    return `yarn remove ${packages.join(' ')}`;
  }

  async runAudit(): Promise<Map<string, AuditSeverity>> {
    logger.info(`Running yarn audit in ${this.cwd}.`);
    let output = '';
    try {
      const result = await execFileAsync('yarn', ['audit', '--json'], { cwd: this.cwd }) as { stdout: string } | string;
      output = typeof result === 'string' ? result : result.stdout;
    }
    catch (err) {
      const stdout = getExecStdout(err);
      if (stdout !== undefined) {
        output = stdout;
      }
      else {
        logger.error('yarn audit failed.', err);
        throw err;
      }
    }
    return this.parseYarnAuditNdjson(output);
  }

  private parseYarnAuditNdjson(output: string): Map<string, AuditSeverity> {
    const vulnerabilities = new Map<string, AuditSeverity>();

    for (const line of output.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        const json = JSON.parse(line);
        if (json.type === 'auditAdvisory' && json.data?.advisory) {
          const { module_name, severity: rawSeverity } = json.data.advisory;
          if (!module_name) {
            continue;
          }
          const severity = parseSeverity(rawSeverity);
          if (severity === undefined) {
            continue;
          }
          const existing = vulnerabilities.get(module_name);
          vulnerabilities.set(module_name, existing === undefined ? severity : mergeSeverity(existing, severity));
        }
      }
      catch {
        // ignore parse errors for individual lines
      }
    }
    logger.info(`Audit complete: ${vulnerabilities.size} vulnerable package(s).`);
    return vulnerabilities;
  }
}