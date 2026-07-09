import { ClientManager, PackageManager } from '../clients';
import { formatShellTaskCommandForLog } from './shellTask';

const clientManager = new ClientManager();

export type { PackageManager };

export async function detectPackageManager(cwd?: string): Promise<PackageManager> {
  return await clientManager.detectPackageManager(cwd);
}

export function buildInstallCommand(
  packageManager: PackageManager,
  packageName: string,
  version: string,
): string {
  return buildPackageUpdateCommand(packageManager, [{ packageName, version, section: 'dependencies' }]);
}

export function buildPackageUpdateCommand(
  packageManager: PackageManager,
  updates: readonly { packageName: string; version: string; section: 'dependencies' | 'devDependencies' }[],
): string {
  const command = clientManager
    .createClient(packageManager, '')
    .buildUpdateCommand(updates.map(update => ({
      name: update.packageName,
      version: update.version,
      section: update.section,
    })));

  return formatShellTaskCommandForLog(command);
}

export function buildRunInstallCommand(packageManager: PackageManager): string {
  return formatShellTaskCommandForLog(clientManager.createClient(packageManager, '').buildInstallCommand());
}