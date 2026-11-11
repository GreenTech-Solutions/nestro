import * as vscode from 'vscode';
import { runBunAudit, runNpmAudit, runPackageAudit, runYarnAudit } from '../utils';
import type { AuditResult, ShellTaskCommand } from '../utils';
import { PACKAGE_MANAGERS } from '../shared';
import type { PackageManager, PackageManagerSpec } from '../shared';
import { validatePackageName, validatePackageVersionSpec } from './operandValidation';

export type DependencySection = 'dependencies' | 'devDependencies';

export interface PackageTarget {
  name: string;
  version: string;
  section: DependencySection;
}

interface Operand {
  readonly name: string;
  readonly version?: string;
}

/** Builds the shell-task argv and runs the audit of one package manager, driven by the `PACKAGE_MANAGERS` table. */
export class PackageManagerClient {
  private readonly spec: PackageManagerSpec;

  constructor(
    readonly packageManager: PackageManager,
    private readonly cwd: string,
    private readonly atWorkspaceRoot = false,
  ) {
    this.spec = PACKAGE_MANAGERS[packageManager];
  }

  buildUpdateCommand(packages: readonly PackageTarget[]): ShellTaskCommand {
    const flags = [
      ...(selectSection(packages) === 'devDependencies' ? [this.spec.devFlag] : []),
      ...this.workspaceRootFlags(this.spec.workspaceRootFlag !== undefined),
    ];
    return this.buildArgv(this.spec.addVerb, flags, packages);
  }

  buildInstallCommand(): ShellTaskCommand {
    return { command: this.spec.bin, args: [this.spec.installVerb] };
  }

  buildRemoveCommand(packages: readonly string[]): ShellTaskCommand {
    const flags = this.workspaceRootFlags(this.spec.removeNeedsWorkspaceRootFlag === true);
    return this.buildArgv(this.spec.removeVerb, flags, packages.map(name => ({ name })));
  }

  async runAuditReport(signal?: AbortSignal): Promise<AuditResult> {
    switch (this.packageManager) {
      case 'npm':
        return await runNpmAudit(this.cwd, signal);
      case 'pnpm':
        return await runPackageAudit('pnpm', this.cwd, signal);
      case 'yarn':
        return await runYarnAudit(this.cwd, signal);
      case 'bun':
        return await runBunAudit(this.cwd, signal);
    }
  }

  /** The only place that validates operands and inserts the `--` that keeps a name from parsing as an option. */
  private buildArgv(verb: string, flags: readonly string[], operands: readonly Operand[]): ShellTaskCommand {
    const quoted = operands.map((operand) => {
      validatePackageName(operand.name);
      if (operand.version === undefined) {
        return quoteShellArg(operand.name);
      }
      validatePackageVersionSpec(operand.version);
      return quoteShellArg(`${operand.name}@${operand.version}`);
    });
    return { command: this.spec.bin, args: [verb, ...flags, '--', ...quoted] };
  }

  private workspaceRootFlags(applies: boolean): string[] {
    const flag = this.spec.workspaceRootFlag;
    return applies && this.atWorkspaceRoot && flag !== undefined ? [flag] : [];
  }
}

function selectSection(packages: readonly PackageTarget[]): DependencySection | undefined {
  const sections = new Set(packages.map(packageTarget => packageTarget.section));
  if (sections.size > 1) {
    throw new Error(vscode.l10n.t('One command can change only one dependency section; update dependencies and devDependencies separately.'));
  }
  return sections.values().next().value;
}

function quoteShellArg(value: string): vscode.ShellQuotedString {
  return { value, quoting: vscode.ShellQuoting.Strong };
}