import { ClientManager } from '../clients';
import { DEFAULT_PACKAGE_MANAGER } from '../shared';
import type { PackageManager } from '../shared';

const clientManager = new ClientManager();

export async function detectPackageManager(cwd: string | undefined): Promise<PackageManager> {
  return cwd === undefined ? DEFAULT_PACKAGE_MANAGER : await clientManager.detectPackageManager(cwd);
}