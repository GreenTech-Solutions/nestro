import { AuditResult, runPackageAudit } from '../utils/auditClient';
import { Client, PackageTarget } from './Client';

export class PnpmClient extends Client {
  buildUpdateCommand(packages: readonly PackageTarget[]) {
    return {
      command: 'pnpm',
      args: ['add', ...this.getSectionArgs(packages, '--save-dev'), '--', ...this.formatPackageTargets(packages)],
    };
  }

  buildInstallCommand() {
    return { command: 'pnpm', args: ['install'] };
  }

  buildRemoveCommand(packages: readonly string[]) {
    return { command: 'pnpm', args: ['remove', '--', ...this.formatPackageNames(packages)] };
  }

  async runAuditReport(signal?: AbortSignal): Promise<AuditResult> {
    return await runPackageAudit('pnpm', this.cwd, signal);
  }
}