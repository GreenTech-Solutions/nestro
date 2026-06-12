import { AuditSeverity, runPackageAudit } from '../utils/auditClient';
import { Client, PackageTarget } from './Client';

export class BunClient extends Client {
  buildUpdateCommand(packages: readonly PackageTarget[]): string {
    return `bun add ${this.formatPackageTargets(packages)}${this.getSectionFlag(packages, '--dev')}`;
  }

  buildInstallCommand(): string {
    return 'bun install';
  }

  buildRemoveCommand(packages: readonly string[]): string {
    return `bun remove ${packages.join(' ')}`;
  }

  async runAudit(): Promise<Map<string, AuditSeverity>> {
    return (await runPackageAudit('bun', this.cwd)).vulnerabilities;
  }
}