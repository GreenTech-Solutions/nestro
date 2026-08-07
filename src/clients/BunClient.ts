import { AuditSeverity } from '../utils/auditClient';
import { runBunAudit } from '../utils/bunAuditClient';
import { Client, PackageTarget } from './Client';

export class BunClient extends Client {
  buildUpdateCommand(packages: readonly PackageTarget[]) {
    return {
      command: 'bun',
      args: ['add', ...this.formatPackageTargets(packages), ...this.getSectionArgs(packages, '--dev')],
    };
  }

  buildInstallCommand() {
    return { command: 'bun', args: ['install'] };
  }

  buildRemoveCommand(packages: readonly string[]) {
    return { command: 'bun', args: ['remove', ...this.formatPackageNames(packages)] };
  }

  async runAudit(): Promise<Map<string, AuditSeverity>> {
    return (await runBunAudit(this.cwd)).vulnerabilities;
  }
}