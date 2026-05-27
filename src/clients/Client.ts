import { AuditResult, AuditSeverity, runNpmAudit } from '../utils/auditClient';

export interface PackageTarget {
  name: string;
  version: string;
}

export interface InstallOptions {
  packages: readonly PackageTarget[];
  cwd: string;
  dev?: boolean;
}

export interface RemoveOptions {
  packages: readonly string[];
  cwd: string;
}

export abstract class Client {
  constructor(protected readonly cwd: string) {}

  abstract buildUpdateCommand(packages: readonly PackageTarget[]): string;
  abstract buildInstallCommand(): string;
  abstract buildRemoveCommand(packages: readonly string[]): string;

  async runAudit(): Promise<Map<string, AuditSeverity>> {
    const result: AuditResult = await runNpmAudit(this.cwd);
    return result.vulnerabilities;
  }

  protected formatPackageTargets(packages: readonly PackageTarget[]): string {
    return packages.map(packageTarget => `${packageTarget.name}@${packageTarget.version}`).join(' ');
  }
}