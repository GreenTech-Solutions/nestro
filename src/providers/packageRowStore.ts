import { packageIdentityFromValues, packageIdentityKey } from './packageIdentity';
import type { PackageIdentityTuple } from './packageIdentity';
import type { PackageTreeEntry } from './treeBuilder';

export class PackageRowStore {
  private rows: PackageTreeEntry[] = [];

  constructor(private readonly noteRowMutation: (identity: PackageIdentityTuple) => void) {}

  get allEntries(): readonly PackageTreeEntry[] {
    return this.rows;
  }

  findEntryIndex(identity: PackageIdentityTuple): number {
    const key = packageIdentityKey(identity);
    return this.rows.findIndex(entry => packageIdentityKey(identityForEntry(entry)) === key);
  }

  /** Applies a snapshot or presentation rebuild without changing row mutation epochs. */
  replaceAll(entries: readonly PackageTreeEntry[]): void {
    this.rows = [...entries];
  }

  patchRow(identity: PackageIdentityTuple, item: PackageTreeEntry['item']): PackageTreeEntry | undefined {
    const index = this.findEntryIndex(identity);
    const current = this.rows[index];
    if (current === undefined) {
      return undefined;
    }
    if (current.item === item) {
      return current;
    }

    this.noteRowMutation(identity);
    const replacement = { ...current, item };
    this.rows = this.rows.map((entry, rowIndex) => rowIndex === index ? replacement : entry);
    return replacement;
  }

  restoreAt(index: number, entry: PackageTreeEntry): void {
    const current = this.rows[index];
    if (current === undefined) {
      this.noteRowMutation(identityForEntry(entry));
    }
    else if (current.item !== entry.item) {
      const currentIdentity = identityForEntry(current);
      const entryIdentity = identityForEntry(entry);
      this.noteRowMutation(currentIdentity);
      if (packageIdentityKey(currentIdentity) !== packageIdentityKey(entryIdentity)) {
        this.noteRowMutation(entryIdentity);
      }
    }
    this.rows[index] = entry;
  }
}

function identityForEntry(entry: PackageTreeEntry): PackageIdentityTuple {
  return packageIdentityFromValues(entry.item.packageName, entry.packageFilePath, entry.dev);
}