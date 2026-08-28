import type { AuditResult } from '../utils/auditClient';
import { runYarnAudit } from '../utils/yarnAuditClient';
import { Client, PackageTarget } from './Client';

export class YarnClient extends Client {
  buildUpdateCommand(packages: readonly PackageTarget[]) {
    return {
      command: 'yarn',
      args: ['add', ...this.getSectionArgs(packages, '--dev'), '--', ...this.formatPackageTargets(packages)],
    };
  }

  buildInstallCommand() {
    return { command: 'yarn', args: ['install'] };
  }

  buildRemoveCommand(packages: readonly string[]) {
    return { command: 'yarn', args: ['remove', '--', ...this.formatPackageNames(packages)] };
  }

  async runAuditReport(signal?: AbortSignal): Promise<AuditResult> {
    return await runYarnAudit(this.cwd, signal);
  }
}