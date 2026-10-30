import { AuditResult } from '../utils/auditClient';
import { runBunAudit } from '../utils/bunAuditClient';
import { Client, PackageTarget } from './Client';
import { PACKAGE_MANAGERS } from '../shared';

const spec = PACKAGE_MANAGERS.bun;

export class BunClient extends Client {
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

  async runAuditReport(signal?: AbortSignal): Promise<AuditResult> {
    return await runBunAudit(this.cwd, signal);
  }
}