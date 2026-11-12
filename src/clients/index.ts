export { ClientManager } from './ClientManager';
export { PackageManagerClient } from './PackageManagerClient';
export { validatePackageName, validatePackageVersionSpec } from './operandValidation';
// projectResolver.ts's detection helpers stay internal to this folder; only the project
// graph entry points and the PackageManager/AuditProject types are public surface.
export { resolveAuditProjects, resolveMutationCoordinatorKey } from './projectResolver';
export type { AuditProject, PackageManager } from './projectResolver';