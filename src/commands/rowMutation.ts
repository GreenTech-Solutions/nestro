import { resolveMutationCoordinatorKey } from '../clients';
import type { PackagesProvider, PackageStateIdentity, ResolvedPackageItem } from '../providers';
import { mutationCoordinator } from '../utils';

export interface RowMutationProgress {
  readonly kind: 'capabilities';
  readonly provider: Pick<PackagesProvider, 'markPackageUpdatingForCapability'>;
  readonly capabilities: readonly ResolvedPackageItem[];
}

export interface IdentityMutationProgress {
  readonly kind: 'identities';
  readonly provider: Pick<PackagesProvider, 'markPackageUpdating'>;
  readonly identities: readonly PackageStateIdentity[];
}

export interface CapabilityMutationUpdate {
  readonly capability: ResolvedPackageItem;
  readonly operation: Parameters<PackagesProvider['markPackageUpdatingForCapability']>[1];
}

export type RowMutationExecution<Checked, Marked, Applied>
  = | { readonly kind: 'applied'; readonly checked: Checked; readonly marked: Marked; readonly result: Applied }
    | { readonly kind: 'apply-failed'; readonly checked: Checked; readonly marked: Marked; readonly error: unknown };

export interface RowMutationSpec<Input, Resolved, Checked, Marked, Applied> {
  guard(input: Input): boolean;
  resolve(input: Input): Resolved | undefined | Promise<Resolved | undefined>;
  lockTargets(resolved: Resolved): readonly string[];
  revalidate(resolved: Resolved): Checked | undefined | Promise<Checked | undefined>;
  mark(checked: Checked): Marked | undefined;
  apply(checked: Checked, marked: Marked): Promise<Applied>;
  reconcile(execution: RowMutationExecution<Checked, Marked, Applied>): void | Promise<void>;
  reportError(error: unknown): void;
}

/** Runs row mutations under canonical project locks in the shared step order. */
export async function runRowMutation<Input, Resolved, Checked, Marked, Applied>(
  input: Input,
  spec: RowMutationSpec<Input, Resolved, Checked, Marked, Applied>,
): Promise<void> {
  if (!spec.guard(input)) {
    return;
  }
  let resolved: Resolved | undefined;
  try {
    resolved = await spec.resolve(input);
  }
  catch (error) {
    spec.reportError(error);
    return;
  }
  if (resolved === undefined) {
    return;
  }
  let projectKeys: string[];
  try {
    projectKeys = await Promise.all(spec.lockTargets(resolved).map(resolveMutationCoordinatorKey));
  }
  catch (error) {
    spec.reportError(error);
    return;
  }
  await mutationCoordinator.runManyExclusive(projectKeys, () => runLockedMutation(resolved, spec));
}

async function runLockedMutation<Input, Resolved, Checked, Marked, Applied>(
  resolved: Resolved,
  spec: RowMutationSpec<Input, Resolved, Checked, Marked, Applied>,
): Promise<void> {
  let checked: Checked | undefined;
  try {
    checked = await spec.revalidate(resolved);
  }
  catch (error) {
    spec.reportError(error);
    return;
  }
  if (checked === undefined) {
    return;
  }
  await markApplyAndReconcile(checked, spec);
}

async function markApplyAndReconcile<Input, Resolved, Checked, Marked, Applied>(
  checked: Checked,
  spec: RowMutationSpec<Input, Resolved, Checked, Marked, Applied>,
): Promise<void> {
  let marked: Marked | undefined;
  try {
    marked = spec.mark(checked);
  }
  catch (error) {
    spec.reportError(error);
    return;
  }
  if (marked === undefined) {
    return;
  }
  let result: Applied;
  try {
    result = await spec.apply(checked, marked);
  }
  catch (error) {
    await spec.reconcile({ kind: 'apply-failed', checked, marked, error });
    spec.reportError(error);
    return;
  }
  try {
    await spec.reconcile({ kind: 'applied', checked, marked, result });
  }
  catch (error) {
    spec.reportError(error);
  }
}

/** Marks each current capability and rolls back partial progress when one row is stale. */
export function markPackageCapabilities(
  provider: Pick<PackagesProvider, 'markPackageUpdatingForCapability'>,
  updates: readonly CapabilityMutationUpdate[],
): RowMutationProgress | undefined {
  const capabilities: ResolvedPackageItem[] = [];
  for (const update of updates) {
    const capability = provider.markPackageUpdatingForCapability(update.capability, update.operation);
    if (capability === undefined) {
      clearMutationProgress({ kind: 'capabilities', provider, capabilities });
      return undefined;
    }
    capabilities.push(capability);
  }
  return { kind: 'capabilities', provider, capabilities };
}

/** Marks every row from a manifest through the provider's identity-based mutation API. */
export function markPackageIdentities(
  provider: Pick<PackagesProvider, 'markPackageUpdating'>,
  identities: readonly PackageStateIdentity[],
  operation: Parameters<PackagesProvider['markPackageUpdating']>[1],
): IdentityMutationProgress {
  identities.forEach(identity => provider.markPackageUpdating(identity, operation));
  return { kind: 'identities', provider, identities };
}

/** Clears progress through the provider so every replacement invalidates old capabilities. */
export function clearMutationProgress(progress: RowMutationProgress | IdentityMutationProgress): void {
  if (progress.kind === 'capabilities') {
    progress.capabilities.forEach(capability => progress.provider.markPackageUpdatingForCapability(capability, undefined));
    return;
  }
  progress.identities.forEach(identity => progress.provider.markPackageUpdating(identity, undefined));
}