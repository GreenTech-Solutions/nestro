import * as vscode from 'vscode';
import type { AuditResult, AuditSeverity } from '../utils/auditClient';
import { validatePackageName, validatePackageVersionSpec } from './operandValidation';
import { ShellTaskCommand } from '../utils/shellTask';

export type DependencySection = 'dependencies' | 'devDependencies';

export interface PackageTarget {
  name: string;
  version: string;
  section: DependencySection;
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

  abstract buildUpdateCommand(packages: readonly PackageTarget[]): ShellTaskCommand;
  abstract buildInstallCommand(): ShellTaskCommand;
  abstract buildRemoveCommand(packages: readonly string[]): ShellTaskCommand;

  abstract runAuditReport(signal?: AbortSignal): Promise<AuditResult>;

  async runAudit(signal?: AbortSignal): Promise<Map<string, AuditSeverity>> {
    const result = await this.runAuditReport(signal);
    return new Map(result.vulnerabilities);
  }

  protected formatPackageTargets(packages: readonly PackageTarget[]): vscode.ShellQuotedString[] {
    return packages.map((packageTarget) => {
      validatePackageName(packageTarget.name);
      validatePackageVersionSpec(packageTarget.version);
      return this.quoteShellArg(`${packageTarget.name}@${packageTarget.version}`);
    });
  }

  protected formatPackageNames(packages: readonly string[]): vscode.ShellQuotedString[] {
    return packages.map((packageName) => {
      validatePackageName(packageName);
      return this.quoteShellArg(packageName);
    });
  }

  protected getSectionArgs(packages: readonly PackageTarget[], devFlag: string): string[] {
    const hasDevDependencies = packages.some(packageTarget => packageTarget.section === 'devDependencies');
    return hasDevDependencies ? [devFlag] : [];
  }

  private quoteShellArg(value: string): vscode.ShellQuotedString {
    return { value, quoting: vscode.ShellQuoting.Strong };
  }
}