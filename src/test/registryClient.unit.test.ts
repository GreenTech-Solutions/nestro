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
  it('returns every version when the list is short', () => {
    expect(selectVersionsForPicker(['1.2.0', '1.1.0', '1.0.0'], {}, '1.0.0')).toEqual([
      '1.2.0',
      '1.1.0',
      '1.0.0',
    ]);
  });

  it('keeps a compact set for long version histories', () => {
    const versions = makeVersions(50);
    const selected = selectVersionsForPicker(versions, { latest: versions[0] }, versions.at(-1) ?? '');

    expect(selected.length).toBeLessThanOrEqual(25);
  });

  it('always includes the latest tag', () => {
    const versions = makeVersions(50);
    const selected = selectVersionsForPicker(versions, { latest: '1.10.0' }, '1.0.0');

    expect(selected).toContain('1.10.0');
  });

  it('does not return duplicate versions', () => {
    const versions = makeVersions(50);
    const selected = selectVersionsForPicker(versions, { latest: versions[0], next: versions[0] }, versions[0]);

    expect(new Set(selected).size).toBe(selected.length);
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

function makeVersions(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const version = count - index;
    return `1.${version}.0`;
  });
}