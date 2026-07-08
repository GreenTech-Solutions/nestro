import { AuditSeverity, runPackageAudit } from '../utils/auditClient';
import { Client, PackageTarget } from './Client';

export class PnpmClient extends Client {
  buildUpdateCommand(packages: readonly PackageTarget[]) {
    return {
      command: 'pnpm',
      args: ['add', ...this.formatPackageTargets(packages), ...this.getSectionArgs(packages, '--save-dev')],
    };
  }

  buildInstallCommand() {
    return { command: 'pnpm', args: ['install'] };
  }

  buildRemoveCommand(packages: readonly string[]) {
    return { command: 'pnpm', args: ['remove', ...this.formatPackageNames(packages)] };
  }

  async runAudit(): Promise<Map<string, AuditSeverity>> {
    return (await runPackageAudit('pnpm', this.cwd)).vulnerabilities;
  }
}
