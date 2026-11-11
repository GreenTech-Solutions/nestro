import { getUpdateType } from '../utils';
import { normalizeOperation } from './PackageItem';
import type { PackageOperationInput } from './PackageItem';
import type { PackageIdentityTuple, PackageItemRecord, ResolvedPackageItem } from './packageIdentity';
import type { PackageCapabilityOperations } from './packageCapabilityOperations';
import type { PackageProviderState } from './packageProviderState';
import type { PackageTreeEntry } from './treeBuilder';

type PackageStateIdentity = PackageIdentityTuple;

/** Applies row-level update and progress changes while preserving capability freshness. */
export class PackageRowMutationService {
  constructor(
    private readonly state: PackageProviderState,
    private readonly capabilities: PackageCapabilityOperations,
    private readonly emitTreeChanged: () => void,
  ) {}

  getPackageIdentitiesForFile(packageFilePath: string): PackageStateIdentity[] {
    return this.state.rowStore.allEntries
      .filter(entry => entry.packageFilePath === packageFilePath)
      .map(entry => this.state.packageItemRecords.get(entry.item)?.identity)
      .filter((identity): identity is PackageStateIdentity => identity !== undefined);
  }

  markPackageUpdated(identity: PackageStateIdentity, newVersion: string): void {
    const index = this.state.rowStore.findEntryIndex(identity);
    const entry = index === -1 ? undefined : this.state.rowStore.allEntries[index];
    if (entry === undefined) {
      return;
    }
    const replacement = this.state.createPackageItem({
      packageName: identity.packageName,
      currentVersion: entry.item.versionPrefix + newVersion,
      updateType: 'none',
      packageFilePath: entry.packageFilePath,
      dev: entry.dev,
      versionPrefix: entry.item.versionPrefix,
    });
    if (this.state.rowStore.patchRow(identity, replacement) === undefined) {
      return;
    }
    this.emitTreeChanged();
  }

  markPackageUpdatedForCapability(capability: ResolvedPackageItem, newVersion: string): void {
    const record = this.capabilities.getCurrentCapabilityRecord(capability);
    if (record === undefined) {
      return;
    }
    const index = this.state.rowStore.findEntryIndex(record.identity);
    const entry = index === -1 ? undefined : this.state.rowStore.allEntries[index];
    const currentRecord = entry === undefined ? undefined : this.state.packageItemRecords.get(entry.item);
    if (entry === undefined || currentRecord === undefined) {
      return;
    }
    const row = currentRecord.row;
    const replacement = this.state.createPackageItem({
      packageName: row.packageName,
      currentVersion: row.versionPrefix + newVersion,
      updateType: 'none',
      packageFilePath: row.packageFilePath,
      dev: row.dev,
      versionPrefix: row.versionPrefix,
    });
    if (this.state.rowStore.patchRow(record.identity, replacement) === undefined) {
      return;
    }
    this.emitTreeChanged();
  }

  resetUpdateData(invalidateUpdateCache: () => void): void {
    invalidateUpdateCache();
    this.state.rowStore.replaceAll(this.state.rowStore.allEntries.map(({ item, dev, packageFilePath }) => ({
      item: this.state.createPackageItem({
        packageName: item.packageName,
        currentVersion: item.currentVersion,
        updateType: 'none',
        operation: item.operation,
        packageFilePath,
        dev,
        versionPrefix: item.versionPrefix,
      }),
      dev,
      packageFilePath,
    })));
    this.emitTreeChanged();
  }

  markPackageUpdating(identity: PackageStateIdentity, operation: PackageOperationInput): void {
    const index = this.state.rowStore.findEntryIndex(identity);
    const entry = index === -1 ? undefined : this.state.rowStore.allEntries[index];
    if (entry === undefined) {
      return;
    }
    const { item, dev, packageFilePath } = entry;
    const activeOperation = normalizeOperation(operation, item.latest ?? item.currentVersion);
    const updateType = activeOperation !== undefined || item.latest === undefined
      ? item.updateType
      : getUpdateType(item.currentVersion, item.latest);
    const replacement = this.state.createPackageItem({
      packageName: item.packageName,
      currentVersion: item.currentVersion,
      latest: item.latest,
      updateType,
      operation: activeOperation,
      packageFilePath,
      dev,
      versionPrefix: item.versionPrefix,
      releaseAge: item.releaseAge,
    });
    if (this.state.rowStore.patchRow(identity, replacement) === undefined) {
      return;
    }
    this.emitTreeChanged();
  }

  markPackageUpdatingForCapability(
    capability: ResolvedPackageItem,
    operation: PackageOperationInput,
  ): ResolvedPackageItem | undefined {
    const record = this.capabilities.getCurrentCapabilityRecord(capability);
    if (record === undefined) {
      return undefined;
    }
    const index = this.state.rowStore.findEntryIndex(record.identity);
    const currentEntry = index === -1 ? undefined : this.state.rowStore.allEntries[index];
    const currentRecord = currentEntry === undefined
      ? undefined
      : this.state.packageItemRecords.get(currentEntry.item);
    if (currentEntry === undefined || currentRecord === undefined) {
      return undefined;
    }
    const generation = this.state.packageSnapshotGeneration;
    const previousEntry = currentEntry;
    const previousRecord = currentRecord;
    const row = currentRecord.row;
    const activeOperation = normalizeOperation(operation, row.latest ?? row.currentVersion);
    const updateType = activeOperation !== undefined || row.latest === undefined
      ? row.updateType
      : getUpdateType(row.currentVersion, row.latest);
    const replacement = this.state.createPackageItem({
      packageName: row.packageName,
      currentVersion: row.currentVersion,
      latest: row.latest,
      updateType,
      operation: activeOperation,
      packageFilePath: row.packageFilePath,
      dev: row.dev,
      versionPrefix: row.versionPrefix,
      releaseAge: row.releaseAge,
    });
    if (this.state.rowStore.patchRow(record.identity, replacement) === undefined) {
      return undefined;
    }
    this.emitTreeChanged();
    const replacementEntry = this.state.rowStore.allEntries[index];
    if (replacementEntry === undefined
      || generation !== this.state.packageSnapshotGeneration
      || this.state.loading
      || this.capabilities.findCurrentEntry(record.identity, replacementEntry.item) === undefined) {
      this.restorePackageEntryAfterProgressRace(record.identity, index, previousEntry, previousRecord);
      return undefined;
    }
    const replacementRecord = this.state.packageItemRecords.get(replacementEntry.item);
    if (replacementRecord === undefined) {
      return undefined;
    }
    return this.state.capabilities.issue(
      record.identity,
      replacementRecord.row,
      record,
      this.state.packageSnapshotGeneration,
    ).value;
  }

  private restorePackageEntryAfterProgressRace(
    identity: PackageStateIdentity,
    originalIndex: number,
    originalEntry: PackageTreeEntry,
    originalRecord: PackageItemRecord,
  ): void {
    const currentEntry = this.state.rowStore.allEntries[originalIndex];
    if (currentEntry?.item === originalEntry.item || currentEntry?.item === undefined) {
      this.state.rowStore.restoreAt(originalIndex, originalEntry);
      this.state.packageItemRecords.set(originalEntry.item, originalRecord);
    }
    else {
      this.restoreCurrentRowOperation(identity, originalRecord);
    }
    this.emitTreeChanged();
  }

  private restoreCurrentRowOperation(
    identity: PackageStateIdentity,
    originalRecord: PackageItemRecord,
  ): void {
    const currentIndex = this.state.rowStore.findEntryIndex(identity);
    const entry = currentIndex === -1 ? undefined : this.state.rowStore.allEntries[currentIndex];
    const record = entry === undefined ? undefined : this.state.packageItemRecords.get(entry.item);
    if (entry === undefined || record === undefined) {
      return;
    }
    const row = record.row;
    const replacement = this.state.createPackageItem({
      packageName: row.packageName,
      currentVersion: row.currentVersion,
      latest: row.latest,
      updateType: row.updateType,
      operation: originalRecord.row.operation,
      packageFilePath: row.packageFilePath,
      dev: row.dev,
      versionPrefix: row.versionPrefix,
      releaseAge: row.releaseAge,
    });
    this.state.rowStore.patchRow(identity, replacement);
  }
}