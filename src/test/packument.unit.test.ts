import { EventEmitter } from 'node:events';
import * as https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPackageMetadataFromNativeCli } from '../utils/nativeMetadataClient';
import {
  fetchPackageMetadataFromYarnClassic,
  fetchPackageMetadataFromYarnModern,
} from '../utils/yarnMetadataClient';
import { parsePackument } from '../utils/metadata/packument';
import { fetchPackageMetadataFromRegistry } from '../utils/registryClient';
import type { MetadataAdapter } from '../utils/metadataRegistry';
import type { PackageMetadataOutcome } from '../utils';

const runBoundedProcessMock = vi.hoisted(() => vi.fn());
const resolveYarnFamilyMock = vi.hoisted(() => vi.fn());

vi.mock('node:https', () => ({ get: vi.fn() }));
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('missing config')),
}));
vi.mock('../utils/processRunner', () => ({ runBoundedProcess: runBoundedProcessMock }));
vi.mock('../utils/yarnFamily', () => ({ resolveYarnFamily: resolveYarnFamilyMock }));

const packument = {
  'dist-tags': { latest: '2.0.0' },
  versions: { '1.0.0': {}, '1.1.0': {}, '2.0.0': {} },
  time: { created: '2020-01-01T00:00:00.000Z', '1.0.0': '2020-02-01T00:00:00.000Z', '2.0.0': '2024-01-01T00:00:00.000Z' },
};

type FetchMetadata = MetadataAdapter['fetchMetadata'];

describe('packument parsing across metadata paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveYarnFamilyMock.mockImplementation(() => Promise.resolve({ family: 'classic', source: 'package-manager' }));
  });

  it('gives the same result for the native CLI, Yarn and HTTPS paths', async () => {
    const outcomes = [
      await fetchViaCli(fetchPackageMetadataFromNativeCli, packument, 'npm'),
      await fetchViaCli(fetchPackageMetadataFromYarnClassic, { type: 'inspect', data: packument }, 'yarn'),
      await fetchViaYarnModern(packument),
      await fetchViaHttps(packument),
    ];

    expect(outcomes[0]).toMatchObject({
      kind: 'success',
      result: {
        versions: ['2.0.0', '1.1.0', '1.0.0'],
        publishTimes: { kind: 'provided', byVersion: { '1.0.0': '2020-02-01T00:00:00.000Z', '2.0.0': '2024-01-01T00:00:00.000Z' } },
      },
    });
    for (const outcome of outcomes) {
      expect(outcome).toEqual(outcomes[0]);
    }
  });

  it.each([
    ['versions entries that are not records', { 'dist-tags': {}, versions: { '1.0.0': 'invalid' } }],
    ['versions that are not a collection', { 'dist-tags': {}, versions: 1 }],
    ['dist-tags values that are not strings', { 'dist-tags': { latest: 1 }, versions: { '1.0.0': {} } }],
  ])('classifies %s as malformed on every path', async (_label, body) => {
    expect(parsePackument(body)).toEqual({ kind: 'malformed' });
    await expect(fetchViaHttps(body)).resolves.toEqual({ kind: 'malformed', reason: 'schema' });
    await expect(fetchViaCli(fetchPackageMetadataFromNativeCli, body, 'npm'))
      .resolves.toEqual({ kind: 'malformed', reason: 'schema' });
  });

  it('accepts an array of versions from a CLI document and orders it newest first', () => {
    expect(parsePackument({ 'dist-tags': {}, versions: ['1.0.0', '2.0.0'] })).toMatchObject({
      kind: 'recognized',
      result: { versions: ['2.0.0', '1.0.0'] },
    });
  });
});

async function fetchViaCli(
  fetchMetadata: FetchMetadata,
  document: unknown,
  packageManager: 'npm' | 'yarn',
): Promise<PackageMetadataOutcome> {
  runBoundedProcessMock.mockResolvedValueOnce({ kind: 'exit', stdout: JSON.stringify(document), stderr: '', exitCode: 0 });
  return await fetchMetadata({ packageName: 'react', packageFilePath: '/workspace/package.json', packageManager });
}

async function fetchViaYarnModern(document: unknown): Promise<PackageMetadataOutcome> {
  resolveYarnFamilyMock.mockResolvedValueOnce({ family: 'modern', source: 'package-manager' });
  return await fetchViaCli(fetchPackageMetadataFromYarnModern, document, 'yarn');
}

async function fetchViaHttps(document: unknown): Promise<PackageMetadataOutcome> {
  vi.mocked(https.get).mockImplementationOnce((_url, _options, callback) => {
    const response = new EventEmitter() as IncomingMessage;
    response.statusCode = 200;
    response.headers = {};
    process.nextTick(() => {
      callback?.(response);
      response.emit('data', JSON.stringify(document));
      response.emit('end');
    });
    return Object.assign(new EventEmitter(), { destroy: vi.fn(), setTimeout: vi.fn() }) as unknown as ClientRequest;
  });
  return await fetchPackageMetadataFromRegistry('react');
}