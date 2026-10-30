import { Client, PackageTarget } from './Client';
import { runNpmAudit } from '../utils/auditClient';
import type { AuditResult } from '../utils/auditClient';
import { PACKAGE_MANAGERS } from '../shared';

const spec = PACKAGE_MANAGERS.npm;

export class NpmClient extends Client {
  async runAuditReport(signal?: AbortSignal): Promise<AuditResult> {
    return await runNpmAudit(this.cwd, signal);
  }

  buildUpdateCommand(packages: readonly PackageTarget[]) {
    return {
      command: spec.bin,
      args: [spec.addVerb, ...this.getSectionArgs(packages, spec.devFlag), '--', ...this.formatPackageTargets(packages)],
    };
  }

  buildInstallCommand() {
    return { command: spec.bin, args: [spec.installVerb] };
  }

  buildRemoveCommand(packages: readonly string[]) {
    return { command: spec.bin, args: [spec.removeVerb, '--', ...this.formatPackageNames(packages)] };
  }
}