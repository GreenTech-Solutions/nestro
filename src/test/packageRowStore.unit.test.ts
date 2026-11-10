import { describe, expect, it, vi } from 'vitest';
import { PackageItem } from '../providers';
import { PackageRowStore } from '../providers/packageRowStore';
import type { PackageIdentityTuple, PackageTreeEntry } from '../providers';

function createEntry(
  packageName: string,
  packageFilePath: string,
  dev: boolean,
  currentVersion = '1.0.0',
): PackageTreeEntry {
  return {
    item: new PackageItem(
      packageName,
      currentVersion,
      undefined,
      'none',
      undefined,
      undefined,
      packageFilePath,
      dev,
    ),
    dev,
    packageFilePath,
  };
}

function identityFor(entry: PackageTreeEntry): PackageIdentityTuple {
  return {
    packageName: entry.item.packageName,
    packageFilePath: entry.packageFilePath,
    section: entry.dev ? 'devDependencies' : 'dependencies',
  };
}

describe('PackageRowStore', () => {
  it('finds rows by package name, manifest path, and dependency section', () => {
    const production = createEntry('react', '/app/package.json', false);
    const development = createEntry('react', '/app/package.json', true);
    const nested = createEntry('react', '/app/tools/package.json', false);
    const store = new PackageRowStore(vi.fn());
    const entries = [production, development, nested];

    store.replaceAll(entries);
    entries.length = 0;

    expect(store.allEntries).toEqual([production, development, nested]);
    expect(store.findEntryIndex(identityFor(development))).toBe(1);
    expect(store.findEntryIndex(identityFor(nested))).toBe(2);
    expect(store.findEntryIndex({
      packageName: 'vue',
      packageFilePath: '/app/package.json',
      section: 'dependencies',
    })).toBe(-1);
  });

  it('records a mutation only when patching an existing row with a new item', () => {
    const entry = createEntry('react', '/app/package.json', false);
    const replacement = createEntry('react', '/app/package.json', false, '2.0.0');
    const noteRowMutation = vi.fn();
    const store = new PackageRowStore(noteRowMutation);
    const identity = identityFor(entry);

    store.replaceAll([entry]);

    expect(store.patchRow({ ...identity, packageName: 'vue' }, replacement.item)).toBeUndefined();
    expect(store.patchRow(identity, entry.item)).toBe(entry);
    expect(noteRowMutation).not.toHaveBeenCalled();

    const patched = store.patchRow(identity, replacement.item);

    expect(patched).toEqual({ ...entry, item: replacement.item });
    expect(store.allEntries[0]).toBe(patched);
    expect(noteRowMutation).toHaveBeenCalledTimes(1);
    expect(noteRowMutation).toHaveBeenCalledWith(identity);
  });

  it('records both identities when restoring a row over a different row', () => {
    const current = createEntry('react', '/app/package.json', false);
    const restored = createEntry('vue', '/tools/package.json', true);
    const noteRowMutation = vi.fn();
    const store = new PackageRowStore(noteRowMutation);

    store.replaceAll([current]);
    store.restoreAt(0, restored);

    expect(store.allEntries[0]).toBe(restored);
    expect(noteRowMutation.mock.calls).toEqual([
      [identityFor(current)],
      [identityFor(restored)],
    ]);
  });

  it('records the restored identity when the target index is empty', () => {
    const restored = createEntry('react', '/app/package.json', false);
    const noteRowMutation = vi.fn();
    const store = new PackageRowStore(noteRowMutation);

    store.restoreAt(0, restored);

    expect(store.allEntries).toEqual([restored]);
    expect(noteRowMutation).toHaveBeenCalledTimes(1);
    expect(noteRowMutation).toHaveBeenCalledWith(identityFor(restored));
  });

  it('records one mutation when restoring the same identity and none for the same item', () => {
    const original = createEntry('react', '/app/package.json', false);
    const replacement = createEntry('react', '/app/package.json', false, '2.0.0');
    const noteRowMutation = vi.fn();
    const store = new PackageRowStore(noteRowMutation);

    store.replaceAll([original]);
    store.restoreAt(0, original);
    expect(noteRowMutation).not.toHaveBeenCalled();

    store.replaceAll([replacement]);
    store.restoreAt(0, original);

    expect(store.allEntries[0]).toBe(original);
    expect(noteRowMutation).toHaveBeenCalledTimes(1);
    expect(noteRowMutation).toHaveBeenCalledWith(identityFor(original));
  });
});