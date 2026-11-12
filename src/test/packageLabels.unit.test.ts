import { describe, expect, it } from 'vitest';
import { resolvePackageFileLabels } from '../providers';
import type { WorkspaceFolderDescriptor } from '../providers/packageLabels';

describe('resolvePackageFileLabels()', () => {
  it('builds one owner label and package-file-relative path from the same resolution', () => {
    const folders: WorkspaceFolderDescriptor[] = [{ path: '/workspace', name: 'workspace', index: 0 }];
    const [root, nested] = resolvePackageFileLabels([
      '/workspace/package.json',
      '/workspace/apps/web/package.json',
    ], folders);

    expect(root).toMatchObject({
      owner: { label: 'workspace — (root)', relativeLabel: '(root)', isRoot: true },
      relativePackageFilePath: 'package.json',
    });
    expect(nested).toMatchObject({
      owner: { label: 'workspace — apps/web', relativeLabel: 'apps/web', isRoot: false },
      relativePackageFilePath: 'apps/web/package.json',
    });
  });

  it('preserves WorkspaceFolder.index ordering for owner labels', () => {
    const folders: WorkspaceFolderDescriptor[] = [
      { path: '/repos/zeta', name: 'zeta', index: 4 },
      { path: '/repos/alpha', name: 'alpha', index: 1 },
    ];
    const labels = resolvePackageFileLabels([
      '/repos/zeta/package.json',
      '/repos/alpha/package.json',
    ], folders);

    expect(labels.map(label => label.owner.label)).toEqual([
      'alpha — (root)',
      'zeta — (root)',
    ]);
  });
});