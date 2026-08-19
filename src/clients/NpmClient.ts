import { Client, PackageTarget } from './Client';
import { runNpmAudit } from '../utils/auditClient';
import type { AuditResult } from '../utils/auditClient';

export class NpmClient extends Client {
  async runAuditReport(signal?: AbortSignal): Promise<AuditResult> {
    return await runNpmAudit(this.cwd, signal);
  }

  buildUpdateCommand(packages: readonly PackageTarget[]) {
    return {
      command: 'npm',
      args: ['install', ...this.formatPackageTargets(packages), ...this.getSectionArgs(packages, '--save-dev')],
    };
  }

  buildInstallCommand() {
    return { command: 'npm', args: ['install'] };
  }

  buildRemoveCommand(packages: readonly string[]) {
    return { command: 'npm', args: ['uninstall', ...this.formatPackageNames(packages)] };
  }
}