export * from './Client';
export * from './ClientManager';
export * from './NpmClient';
export * from './PnpmClient';
export * from './YarnClient';
export * from './BunClient';
export { validatePackageName, validatePackageVersionSpec } from './operandValidation';
// Selective, not `export *`: the rest of projectResolver.ts's exports
// (detectPackageManagerFromManifest/FromLockfile/SignalFromAncestors, parsePackageManager)
// are module-internal helpers `ClientManager.ts` imports directly within this folder —
// only `resolveAuditProjects()` and the `AuditProject` type are part of the public
// surface consumed outside `src/clients/` (N8).
export { resolveAuditProjects, resolveMutationCoordinatorKey } from './projectResolver';
export type { AuditProject } from './projectResolver';