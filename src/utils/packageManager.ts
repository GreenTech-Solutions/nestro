import { ClientManager, PackageManager } from '../clients';

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
  return buildPackageUpdateCommand(packageManager, [{ packageName, version }]);
}

export function buildPackageUpdateCommand(
  packageManager: PackageManager,
  updates: readonly { packageName: string; version: string }[],
): string {
  return clientManager
    .createClient(packageManager, '')
    .buildUpdateCommand(updates.map(update => ({ name: update.packageName, version: update.version })));
}

export function buildRunInstallCommand(packageManager: PackageManager): string {
  return clientManager.createClient(packageManager, '').buildInstallCommand();
}