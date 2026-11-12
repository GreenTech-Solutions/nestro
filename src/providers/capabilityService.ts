import { packageIdentityKey } from './packageIdentity';
import type {
  CanonicalPackageItem,
  CanonicalPackageLocation,
  PackageIdentityTuple,
  ResolvedPackageItem,
} from './packageIdentity';

/** Provider-side data behind one issued capability. */
export interface PackageCapabilityRecord extends CanonicalPackageLocation {
  readonly identity: PackageIdentityTuple;
  /** The row as it was when the capability was issued. */
  readonly row: CanonicalPackageItem;
  readonly snapshotGeneration: number;
  /** The row's mutation count at issue time; rebuilding a row without changing it keeps the count. */
  readonly rowEpoch: number;
}

/**
 * Issues provider-owned row capabilities and decides whether one still describes the
 * current row. A capability is fresh while the snapshot generation, the row's mutation
 * count and the row's manifest spec are unchanged; the `PackageItem` object may be rebuilt.
 */
export class PackageCapabilityService {
  private readonly records = new WeakMap<object, PackageCapabilityRecord>();
  private rowEpochs = new Map<string, number>();

  issue(
    identity: PackageIdentityTuple,
    row: CanonicalPackageItem,
    location: CanonicalPackageLocation,
    snapshotGeneration: number,
  ): { readonly ok: true; readonly value: ResolvedPackageItem } {
    const fileStamp = Object.freeze({ ...location.fileStamp });
    const capability: ResolvedPackageItem = Object.freeze({
      item: row,
      identity,
      packageFilePath: location.packageFilePath,
      packageDirectory: location.packageDirectory,
      workspaceFolderPath: location.workspaceFolderPath,
      fileStamp,
      manifestDigest: location.manifestDigest,
      snapshotGeneration,
    });
    this.records.set(capability, {
      identity,
      row,
      packageFilePath: location.packageFilePath,
      packageDirectory: location.packageDirectory,
      workspaceFolderPath: location.workspaceFolderPath,
      fileStamp,
      manifestDigest: location.manifestDigest,
      snapshotGeneration,
      rowEpoch: this.rowEpoch(identity),
    });
    return { ok: true, value: capability };
  }

  /** The record behind a capability this service issued; `undefined` for anything else. */
  recordOf(value: unknown): PackageCapabilityRecord | undefined {
    return typeof value === 'object' && value !== null ? this.records.get(value) : undefined;
  }

  /** Whether `record` still describes `currentRow` in snapshot generation `generation`. */
  isFresh(record: PackageCapabilityRecord, currentRow: CanonicalPackageItem, generation: number): boolean {
    return record.snapshotGeneration === generation
      && record.rowEpoch === this.rowEpoch(record.identity)
      && record.row.currentVersion === currentRow.currentVersion
      && record.row.versionPrefix === currentRow.versionPrefix;
  }

  /** Invalidates every capability issued for the row before a command changed its state. */
  noteRowMutation(identity: PackageIdentityTuple): void {
    this.rowEpochs.set(packageIdentityKey(identity), this.rowEpoch(identity) + 1);
  }

  /** Forgets all per-row mutation counts when a new package snapshot begins. */
  reset(): void {
    this.rowEpochs = new Map();
  }

  private rowEpoch(identity: PackageIdentityTuple): number {
    return this.rowEpochs.get(packageIdentityKey(identity)) ?? 0;
  }
}