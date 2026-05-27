import { AuditSeverity, runPackageAudit } from '../utils/auditClient';
import { Client, PackageTarget } from './Client';

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
    return (await runPackageAudit('yarn', this.cwd)).vulnerabilities;
  }
}