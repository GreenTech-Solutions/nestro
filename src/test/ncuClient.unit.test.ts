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

  it('propagates a mocked npm-check-updates timeout rejection', async () => {
    const timeoutError = new Error('global timeout exceeded');
    runMock.mockRejectedValueOnce(timeoutError);

    await expect(fetchAllLatestVersions('/workspace/package.json', 'latest', true))
      .rejects.toThrow('global timeout exceeded');
  });
});