import { describe, expect, it, vi } from 'vitest';
import { memoizeRegistrySource, runWithRegistryConfigMemo } from '../utils/registry/configSourceMemo';

describe('registry configuration source memo', () => {
  it('reads a source once per kind and package file in one operation', async () => {
    const read = vi.fn().mockResolvedValue('npm config');

    await runWithRegistryConfigMemo(async () => {
      const values = await Promise.all([
        memoizeRegistrySource('npmrc', '/workspace/package.json', read),
        memoizeRegistrySource('npmrc', '/workspace/package.json', read),
      ]);

      expect(values).toEqual(['npm config', 'npm config']);
    });

    expect(read).toHaveBeenCalledOnce();
  });

  it('reads a source again for a different package file', async () => {
    const read = vi.fn().mockResolvedValue('config');

    await runWithRegistryConfigMemo(async () => {
      await memoizeRegistrySource('npmrc', '/workspace/one/package.json', read);
      await memoizeRegistrySource('npmrc', '/workspace/two/package.json', read);
    });

    expect(read).toHaveBeenCalledTimes(2);
  });

  it('keeps registry source kinds separate', async () => {
    const read = vi.fn().mockResolvedValue('config');

    await runWithRegistryConfigMemo(async () => {
      await memoizeRegistrySource('npmrc', '/workspace/package.json', read);
      await memoizeRegistrySource('bun', '/workspace/package.json', read);
    });

    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reads afresh outside a memo operation', async () => {
    const read = vi.fn().mockResolvedValue('config');

    await memoizeRegistrySource('npmrc', '/workspace/package.json', read);
    await memoizeRegistrySource('npmrc', '/workspace/package.json', read);

    expect(read).toHaveBeenCalledTimes(2);
  });

  it('shares the enclosing memo with a nested operation', async () => {
    const read = vi.fn().mockResolvedValue('config');

    await runWithRegistryConfigMemo(async () => {
      const outerValue = await memoizeRegistrySource('yarn', '/workspace/package.json', read);
      const nestedValue = await runWithRegistryConfigMemo(
        () => memoizeRegistrySource('yarn', '/workspace/package.json', read),
      );

      expect(nestedValue).toBe(outerValue);
    });

    expect(read).toHaveBeenCalledOnce();
  });

  it('does not share sources between independent operations', async () => {
    const read = vi.fn().mockResolvedValue('config');

    await Promise.all([
      runWithRegistryConfigMemo(() => memoizeRegistrySource('npmrc', '/workspace/package.json', read)),
      runWithRegistryConfigMemo(() => memoizeRegistrySource('npmrc', '/workspace/package.json', read)),
    ]);

    expect(read).toHaveBeenCalledTimes(2);
  });

  it('keeps a rejected source promise in the operation memo', async () => {
    const failure = new Error('configuration failed');
    const read = vi.fn().mockRejectedValue(failure);

    await runWithRegistryConfigMemo(async () => {
      const first = memoizeRegistrySource('bun', '/workspace/package.json', read);
      const second = memoizeRegistrySource('bun', '/workspace/package.json', read);

      await expect(first).rejects.toBe(failure);
      await expect(second).rejects.toBe(failure);
    });

    expect(read).toHaveBeenCalledOnce();
  });
});