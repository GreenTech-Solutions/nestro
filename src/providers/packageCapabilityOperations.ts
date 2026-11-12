import { packageIdentityKey, readCanonicalDependencySpec } from './packageIdentity';
import { resolveCanonicalPackageLocation, samePackageFileStamp } from './packageLocationResolution';
import type {
  CanonicalPackageLocation,
  PackageIdentityResolution,
  PackageIdentityTuple,
  PackageItemRecord,
  ResolvedPackageItem,
} from './packageIdentity';
import { isPackageItem } from './PackageItem';
import type { PackageItem } from './PackageItem';
import type { PackageCapabilityRecord } from './capabilityService';
import type { PackageProviderState } from './packageProviderState';
import type { PackageTreeEntry } from './treeBuilder';

/** Resolves provider-issued package capabilities and revalidates them at mutation boundaries. */
export class PackageCapabilityOperations {
  constructor(private readonly state: PackageProviderState) {}

  async resolvePackageItem(value: unknown): Promise<PackageIdentityResolution> {
    if (!isPackageItem(value)) {
      return { ok: false, reason: 'invalid-item' };
    }
    const item = value;

    const record = this.state.packageItemRecords.get(item);
    if (record === undefined) {
      return { ok: false, reason: 'not-current' };
    }
    const { identity } = record;
    const generation = this.state.packageSnapshotGeneration;
    const entry = this.findCurrentEntry(identity, item);
    if (this.state.loading || entry === undefined) {
      return { ok: false, reason: 'not-current' };
    }
    const location = await resolveCanonicalPackageLocation(identity.packageFilePath);
    if (!location.ok) {
      return location;
    }
    if (record.baselineLocation === undefined
      || !sameCanonicalPackageLocation(record.baselineLocation, location.value)) {
      return { ok: false, reason: 'path-replaced' };
    }
    if (await readCanonicalDependencySpec(location.value, identity) !== record.row.currentVersion) {
      return { ok: false, reason: 'path-replaced' };
    }
    if (generation !== this.state.packageSnapshotGeneration || this.findCurrentEntry(identity, item) === undefined) {
      return { ok: false, reason: 'not-current' };
    }
    return this.state.capabilities.issue(identity, record.row, location.value, generation);
  }

  async revalidatePackageItem(value: ResolvedPackageItem): Promise<PackageIdentityResolution> {
    const capabilityRecord = this.state.capabilities.recordOf(value);
    if (capabilityRecord === undefined) {
      return { ok: false, reason: 'invalid-item' };
    }
    const { identity, snapshotGeneration } = capabilityRecord;
    if (this.state.loading || this.findFreshItemRecord(capabilityRecord) === undefined) {
      return { ok: false, reason: 'not-current' };
    }
    const location = await resolveCanonicalPackageLocation(identity.packageFilePath);
    if (!location.ok) {
      return location;
    }
    const baselineRecord = this.findFreshItemRecord(capabilityRecord);
    if (baselineRecord?.baselineLocation === undefined
      || !sameCanonicalPackageLocation(baselineRecord.baselineLocation, location.value)) {
      return { ok: false, reason: 'path-replaced' };
    }
    if (await readCanonicalDependencySpec(location.value, identity) !== baselineRecord.row.currentVersion) {
      return { ok: false, reason: 'path-replaced' };
    }
    if (this.state.loading || this.findFreshItemRecord(capabilityRecord) === undefined) {
      return { ok: false, reason: 'not-current' };
    }
    if (location.value.packageFilePath !== capabilityRecord.packageFilePath
      || location.value.packageDirectory !== capabilityRecord.packageDirectory
      || location.value.workspaceFolderPath !== capabilityRecord.workspaceFolderPath
      || location.value.manifestDigest !== capabilityRecord.manifestDigest
      || !samePackageFileStamp(location.value.fileStamp, capabilityRecord.fileStamp)) {
      return { ok: false, reason: 'path-replaced' };
    }
    return this.state.capabilities.issue(identity, capabilityRecord.row, location.value, snapshotGeneration);
  }

  async refreshPackageBaselineForCapability(
    capability: ResolvedPackageItem,
    expectedCurrentVersion: string,
  ): Promise<ResolvedPackageItem | undefined> {
    const record = this.getCurrentCapabilityRecord(capability);
    if (record === undefined) {
      return undefined;
    }
    const location = await resolveCanonicalPackageLocation(record.identity.packageFilePath);
    if (!location.ok
      || location.value.packageFilePath !== record.packageFilePath
      || location.value.packageDirectory !== record.packageDirectory
      || location.value.workspaceFolderPath !== record.workspaceFolderPath) {
      return undefined;
    }
    if (await readCanonicalDependencySpec(location.value, record.identity) !== expectedCurrentVersion) {
      return undefined;
    }
    if (this.state.loading || this.findFreshItemRecord(record) === undefined) {
      return undefined;
    }
    const baselineLocation = Object.freeze({
      ...location.value,
      fileStamp: Object.freeze({ ...location.value.fileStamp }),
    });
    this.state.packageLocationBaselines.set(record.identity.packageFilePath, baselineLocation);
    for (const entry of this.state.rowStore.allEntries) {
      const entryRecord = this.state.packageItemRecords.get(entry.item);
      if (entryRecord?.identity.packageFilePath === record.identity.packageFilePath) {
        this.state.packageItemRecords.set(entry.item, Object.freeze({ ...entryRecord, baselineLocation }));
      }
    }
    if (this.findFreshItemRecord(record) === undefined) {
      return undefined;
    }
    return this.state.capabilities.issue(record.identity, record.row, location.value, this.state.packageSnapshotGeneration).value;
  }

  async reissuePackageCapability(capability: ResolvedPackageItem): Promise<ResolvedPackageItem | undefined> {
    const record = this.getCurrentCapabilityRecord(capability);
    if (record === undefined) {
      return undefined;
    }
    const location = await resolveCanonicalPackageLocation(record.identity.packageFilePath);
    if (!location.ok) {
      return undefined;
    }
    const currentRecord = this.findFreshItemRecord(record);
    if (currentRecord?.baselineLocation === undefined
      || !sameCanonicalPackageLocation(currentRecord.baselineLocation, location.value)
      || await readCanonicalDependencySpec(location.value, record.identity) !== currentRecord.row.currentVersion) {
      return undefined;
    }
    if (this.state.loading || this.findFreshItemRecord(record) === undefined) {
      return undefined;
    }
    return this.state.capabilities.issue(record.identity, record.row, location.value, record.snapshotGeneration).value;
  }

  getCurrentCapabilityRecord(capability: ResolvedPackageItem): PackageCapabilityRecord | undefined {
    const record = this.state.capabilities.recordOf(capability);
    if (record === undefined || this.state.loading || this.findFreshItemRecord(record) === undefined) {
      return undefined;
    }
    return record;
  }

  findCurrentEntry(identity: PackageIdentityTuple, expectedItem?: PackageItem): PackageTreeEntry | undefined {
    const key = packageIdentityKey(identity);
    const matches = this.state.rowStore.allEntries.filter((entry) => {
      const entryIdentity = this.state.packageItemRecords.get(entry.item)?.identity;
      return entryIdentity !== undefined && packageIdentityKey(entryIdentity) === key;
    });
    if (matches.length !== 1) {
      return undefined;
    }
    const [match] = matches;
    return expectedItem === undefined || match.item === expectedItem ? match : undefined;
  }

  private findFreshItemRecord(capability: PackageCapabilityRecord): PackageItemRecord | undefined {
    const entry = this.findCurrentEntry(capability.identity);
    const record = entry === undefined ? undefined : this.state.packageItemRecords.get(entry.item);
    return record !== undefined && this.state.capabilities.isFresh(
      capability,
      record.row,
      this.state.packageSnapshotGeneration,
    )
      ? record
      : undefined;
  }
}

function sameCanonicalPackageLocation(
  left: CanonicalPackageLocation,
  right: CanonicalPackageLocation,
): boolean {
  return left.packageFilePath === right.packageFilePath
    && left.packageDirectory === right.packageDirectory
    && left.workspaceFolderPath === right.workspaceFolderPath
    && left.manifestDigest === right.manifestDigest
    && samePackageFileStamp(left.fileStamp, right.fileStamp);
}