import { AuditSeverity, runPackageAudit } from '../utils/auditClient';
import { Client, PackageTarget } from './Client';

export class PnpmClient extends Client {
  buildUpdateCommand(packages: readonly PackageTarget[]): string {
    return `pnpm add ${this.formatPackageTargets(packages)}${this.getSectionFlag(packages, '--save-dev')}`;
  }

  buildInstallCommand(): string {
    return 'pnpm install';
  }

  buildRemoveCommand(packages: readonly string[]): string {
    return `pnpm remove ${packages.join(' ')}`;
  }

  async runAudit(): Promise<Map<string, AuditSeverity>> {
    return (await runPackageAudit('pnpm', this.cwd)).vulnerabilities;
  }
}