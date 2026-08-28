import { AuditResult } from '../utils/auditClient';
import { runBunAudit } from '../utils/bunAuditClient';
import { Client, PackageTarget } from './Client';

export class BunClient extends Client {
  buildUpdateCommand(packages: readonly PackageTarget[]) {
    return {
      command: 'bun',
      args: ['add', ...this.getSectionArgs(packages, '--dev'), '--', ...this.formatPackageTargets(packages)],
    };
  }

  buildInstallCommand() {
    return { command: 'bun', args: ['install'] };
  }

  buildRemoveCommand(packages: readonly string[]) {
    return { command: 'bun', args: ['remove', '--', ...this.formatPackageNames(packages)] };
  }

  async runAuditReport(signal?: AbortSignal): Promise<AuditResult> {
    return await runBunAudit(this.cwd, signal);
  }
}