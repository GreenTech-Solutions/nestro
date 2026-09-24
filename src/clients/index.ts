export { BunClient } from './BunClient';
export { ClientManager } from './ClientManager';
export { NpmClient } from './NpmClient';
export { PnpmClient } from './PnpmClient';
export { YarnClient } from './YarnClient';
export { validatePackageName, validatePackageVersionSpec } from './operandValidation';
// projectResolver.ts's detection helpers stay internal to this folder; only the project
// graph entry points and the PackageManager/AuditProject types are public surface.
export { resolveAuditProjects, resolveMutationCoordinatorKey } from './projectResolver';
export type { AuditProject, PackageManager } from './projectResolver';