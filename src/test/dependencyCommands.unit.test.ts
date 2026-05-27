import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pinVersionCommand } from '../commands/pinVersion';
import { switchDepTypeCommand } from '../commands/switchDepType';
import { PackageItem, PackagesProvider } from '../providers';
import { setVersionPin, switchDependencyType } from '../utils';

vi.mock('../utils', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
  setVersionPin: vi.fn(),
  showError: vi.fn(),
  switchDependencyType: vi.fn(),
}));

describe('switchDepTypeCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('moves the package between dependency buckets and refreshes the tree', async () => {
    const provider = makeProvider();
    const item = new PackageItem(
      'react',
      '^18.0.0',
      undefined,
      'none',
      false,
      undefined,
      '/workspace/package.json',
      false,
      '^',
    );

    await switchDepTypeCommand(item, provider);

    expect(switchDependencyType).toHaveBeenCalledWith('/workspace/package.json', 'react', false);
    expect(provider.withWriteSuppressed).toHaveBeenCalledTimes(1);
    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
  });
});

describe('pinVersionCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pins a caret-prefixed package and refreshes the tree', async () => {
    const provider = makeProvider();
    const item = new PackageItem(
      'react',
      '^18.0.0',
      undefined,
      'none',
      false,
      undefined,
      '/workspace/package.json',
      false,
      '^',
    );

    await pinVersionCommand(item, provider);

    expect(setVersionPin).toHaveBeenCalledWith('/workspace/package.json', 'react', true);
    expect(provider.withWriteSuppressed).toHaveBeenCalledTimes(1);
    expect(provider.loadPackages).toHaveBeenCalledTimes(1);
  });

  it('unpins a bare package and refreshes the tree', async () => {
    const provider = makeProvider();
    const item = new PackageItem(
      'react',
      '18.0.0',
      undefined,
      'none',
      false,
      undefined,
      '/workspace/package.json',
      false,
      '',
    );

    await pinVersionCommand(item, provider);

    expect(setVersionPin).toHaveBeenCalledWith('/workspace/package.json', 'react', false);
  });
});

function makeProvider(): PackagesProvider {
  return {
    withWriteSuppressed: vi.fn(async (fn: () => Promise<unknown>) => await fn()) as PackagesProvider['withWriteSuppressed'],
    loadPackages: vi.fn(),
  } as unknown as PackagesProvider;
}