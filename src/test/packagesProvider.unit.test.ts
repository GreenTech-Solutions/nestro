import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupItem, PackagesProvider } from '../providers';
import {
  fetchAllLatestVersions,
  getWorkspacePackageFilePath,
  readWorkspaceDependencies,
} from '../utils';

vi.mock('../utils', () => ({
  fetchAllLatestVersions: vi.fn(),
  getUpdateType: vi.fn((current: string, latest: string) => (
    current.split('.')[0] === latest.split('.')[0] ? 'minor' : 'breaking'
  )),
  getWorkspacePackageFilePath: vi.fn(),
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    dispose: vi.fn(),
  },
  readWorkspaceDependencies: vi.fn(),
  showError: vi.fn(),
}));

describe('PackagesProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getWorkspacePackageFilePath).mockReturnValue('/workspace/package.json');
    vi.mocked(readWorkspaceDependencies).mockResolvedValue([
      { name: 'react', current: '18.0.0', dev: false },
      { name: 'eslint', current: '8.0.0', dev: true },
    ]);
    vi.mocked(fetchAllLatestVersions).mockResolvedValue(new Map([
      ['react', '19.0.0'],
    ]));
  });

  it('starts with the configured initial filter', async () => {
    const provider = new PackagesProvider('hasUpdates');

    await provider.checkUpdates();

    const groups = provider.getChildren().filter((item): item is GroupItem => item instanceof GroupItem);
    expect(provider.getChildren()[0].label).toBe('Filter: Has Updates');
    expect(groups).toHaveLength(1);
    expect(groups[0].children.map(child => child.label)).toEqual(['react']);
  });

  it('allows setFilter to override the initial filter', async () => {
    const provider = new PackagesProvider('hasUpdates');

    await provider.checkUpdates();
    provider.setFilter('all');

    const groups = provider.getChildren().filter((item): item is GroupItem => item instanceof GroupItem);
    expect(provider.getChildren()[0].label).toBe('Filter: All');
    expect(groups.flatMap(group => group.children.map(child => child.label))).toEqual(['react', 'eslint']);
  });
});