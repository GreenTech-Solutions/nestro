import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAllLatestVersions } from '../utils/ncuClient';

const { runMock } = vi.hoisted(() => ({
  runMock: vi.fn(),
}));

vi.mock('npm-check-updates', () => ({
  run: runMock,
}));

describe('fetchAllLatestVersions()', () => {
  beforeEach(() => {
    runMock.mockReset();
  });

  it('loads and reuses the npm-check-updates run function', async () => {
    vi.resetModules();
    let loads = 0;
    vi.doMock('npm-check-updates', () => {
      loads += 1;
      return { run: runMock };
    });

    const { fetchAllLatestVersions: fetchFreshLatestVersions } = await import('../utils/ncuClient');
    runMock.mockResolvedValue({ react: '19.0.0' });

    await fetchFreshLatestVersions('/workspace/first/package.json', 'latest', false);
    expect(loads).toBe(1);

    await fetchFreshLatestVersions('/workspace/second/package.json', 'latest', false);

    expect(loads).toBe(1);
    expect(runMock).toHaveBeenCalledTimes(2);
  });

  it('passes explicit prerelease opt-in and a bounded global timeout to npm-check-updates', async () => {
    runMock.mockResolvedValue({ react: '19.0.0' });

    await expect(fetchAllLatestVersions('/workspace/package.json', 'latest', true))
      .resolves.toEqual(new Map([['react', '19.0.0']]));

    expect(runMock).toHaveBeenCalledWith({
      packageFile: '/workspace/package.json',
      target: 'latest',
      pre: true,
      jsonUpgraded: true,
      removeRange: true,
      silent: true,
      timeout: 60_000,
      cooldown: 7,
    });
  });

  it('keeps prereleases disabled for the greatest target when not requested', async () => {
    runMock.mockResolvedValue({ react: '19.0.0' });

    await expect(fetchAllLatestVersions('/workspace/package.json', 'greatest', false))
      .resolves.toEqual(new Map([['react', '19.0.0']]));

    expect(runMock).toHaveBeenCalledWith({
      packageFile: '/workspace/package.json',
      target: 'greatest',
      pre: false,
      jsonUpgraded: true,
      removeRange: true,
      silent: true,
      timeout: 60_000,
      cooldown: 7,
    });
  });

  it('passes zero cooldown when the release-age policy is disabled', async () => {
    runMock.mockResolvedValue({ react: '19.0.0' });

    await expect(fetchAllLatestVersions('/workspace/package.json', 'latest', false, 0))
      .resolves.toEqual(new Map([['react', '19.0.0']]));

    expect(runMock).toHaveBeenCalledWith({
      packageFile: '/workspace/package.json',
      target: 'latest',
      pre: false,
      jsonUpgraded: true,
      removeRange: true,
      silent: true,
      timeout: 60_000,
      cooldown: 0,
    });
  });

  it('falls back to the default cooldown for an invalid setting', async () => {
    runMock.mockResolvedValue({ react: '19.0.0' });

    await fetchAllLatestVersions('/workspace/package.json', 'latest', false, -1);

    expect(runMock).toHaveBeenCalledWith(expect.objectContaining({ cooldown: 7 }));
  });

  it.each([undefined, null, 19, 'not-an-object', []])('returns no versions for non-object NCU result %s', async (result) => {
    runMock.mockResolvedValue(result);

    await expect(fetchAllLatestVersions('/workspace/package.json', 'latest', false)).resolves.toEqual(new Map());
  });

  it('returns no versions when an object contains non-string values', async () => {
    runMock.mockResolvedValue({ react: 19, vue: null });

    await expect(fetchAllLatestVersions('/workspace/package.json', 'latest', false)).resolves.toEqual(new Map());
  });

  it('propagates a mocked npm-check-updates timeout rejection', async () => {
    const timeoutError = new Error('global timeout exceeded');
    runMock.mockRejectedValueOnce(timeoutError);

    await expect(fetchAllLatestVersions('/workspace/package.json', 'latest', true))
      .rejects.toThrow('global timeout exceeded');
  });
});