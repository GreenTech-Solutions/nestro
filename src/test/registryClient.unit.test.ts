import { EventEmitter } from 'node:events';
import * as https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPackageVersions, selectVersionsForPicker } from '../utils/registryClient';

vi.mock('node:https', () => ({
  get: vi.fn(),
}));

describe('fetchPackageVersions()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses dist-tags and versions from the npm registry response', async () => {
    mockRegistryResponse(JSON.stringify({
      'dist-tags': { latest: '18.2.0', next: '19.0.0-rc.1' },
      versions: {
        '18.0.0': {},
        '18.2.0': {},
      },
    }));

    await expect(fetchPackageVersions('react')).resolves.toEqual({
      tags: { latest: '18.2.0', next: '19.0.0-rc.1' },
      versions: ['18.2.0', '18.0.0'],
    });
  });

  it('rejects on network errors', async () => {
    const error = new Error('network down');
    vi.mocked(https.get).mockImplementationOnce(() => {
      const request = new EventEmitter();
      process.nextTick(() => {
        request.emit('error', error);
      });
      return request as ClientRequest;
    });

    await expect(fetchPackageVersions('react')).rejects.toThrow('network down');
  });
});

describe('selectVersionsForPicker()', () => {
  it('returns the full list sorted by semantic version precedence', () => {
    expect(selectVersionsForPicker(
      ['1.0.0', '10.0.0', '2.0.0-beta.1', '2.0.0'],
      {},
      '1.0.0',
      true,
    )).toEqual([
      '10.0.0',
      '2.0.0',
      '2.0.0-beta.1',
      '1.0.0',
    ]);
  });

  it('filters prereleases when the setting is disabled', () => {
    expect(selectVersionsForPicker(
      ['2.0.0-beta.1', '1.2.0', '1.1.0-alpha.1', '1.0.0'],
      {},
      '1.0.0',
      false,
    )).toEqual([
      '1.2.0',
      '1.0.0',
    ]);
  });

  it('keeps the current and tagged prerelease versions visible when filtering', () => {
    expect(selectVersionsForPicker(
      ['2.0.0-beta.2', '2.0.0-beta.1', '1.2.0', '1.0.0'],
      { next: '2.0.0-beta.2' },
      '2.0.0-beta.1',
      false,
    )).toEqual([
      '2.0.0-beta.2',
      '2.0.0-beta.1',
      '1.2.0',
      '1.0.0',
    ]);
  });
});

function mockRegistryResponse(body: string): void {
  vi.mocked(https.get).mockImplementationOnce((_url, _options, callback) => {
    const response = new EventEmitter() as IncomingMessage;
    process.nextTick(() => {
      callback?.(response);
      response.emit('data', body);
      response.emit('end');
    });
    return new EventEmitter() as ClientRequest;
  });
}
