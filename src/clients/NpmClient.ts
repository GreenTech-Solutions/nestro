import { Client, PackageTarget } from './Client';

export class NpmClient extends Client {
  buildUpdateCommand(packages: readonly PackageTarget[]): string {
    return `npm install ${this.formatPackageTargets(packages)}${this.getSectionFlag(packages, '--save-dev')}`;
  }

  buildInstallCommand(): string {
    return 'npm install';
  }

  buildRemoveCommand(packages: readonly string[]): string {
    return `npm uninstall ${packages.join(' ')}`;
  }
}