import type { AuditResult } from '../utils/auditClient';
import { runYarnAudit } from '../utils/yarnAuditClient';
import { Client, PackageTarget } from './Client';
import { PACKAGE_MANAGERS } from '../shared';

const spec = PACKAGE_MANAGERS.yarn;

export class YarnClient extends Client {
  buildUpdateCommand(packages: readonly PackageTarget[]) {
    return {
      command: spec.bin,
      args: [
        spec.addVerb,
        ...this.getSectionArgs(packages, spec.devFlag),
        ...this.getWorkspaceRootArgs(spec.workspaceRootFlag),
        '--',
        ...this.formatPackageTargets(packages),
      ],
    };
  }

  buildInstallCommand() {
    return { command: spec.bin, args: [spec.installVerb] };
  }

  buildRemoveCommand(packages: readonly string[]) {
    return { command: spec.bin, args: [spec.removeVerb, '--', ...this.formatPackageNames(packages)] };
  }

  async runAuditReport(signal?: AbortSignal): Promise<AuditResult> {
    return await runYarnAudit(this.cwd, signal);
  }
}