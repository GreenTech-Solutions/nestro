import { Client, PackageTarget } from './Client';

export class NpmClient extends Client {
  buildUpdateCommand(packages: readonly PackageTarget[]) {
    return {
      command: 'npm',
      args: ['install', ...this.formatPackageTargets(packages), ...this.getSectionArgs(packages, '--save-dev')],
    };
  }

  buildInstallCommand() {
    return { command: 'npm', args: ['install'] };
  }

  buildRemoveCommand(packages: readonly string[]) {
    return { command: 'npm', args: ['uninstall', ...this.formatPackageNames(packages)] };
  }
}