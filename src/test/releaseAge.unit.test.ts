/* eslint-disable @stylistic/eol-last */

import { describe, expect, it } from 'vitest';
import {
  classifyVersionReleaseAge,
  DEFAULT_MINIMUM_RELEASE_AGE_DAYS,
  MAX_MINIMUM_RELEASE_AGE_DAYS,
  readMinimumReleaseAgeDays,
  resolveUpdateReleaseAge,
} from '../utils';
import type { PackageMetadataOutcome } from '../utils';

const metadata: PackageMetadataOutcome = {
  kind: 'success',
  result: {
    versions: ['1.0.0', '1.1.0', '2.0.0'],
    distTags: { latest: '2.0.0' },
    publishTimes: {
      kind: 'provided',
      byVersion: {
        '1.1.0': '2026-01-01T23:30:00.000Z',
        '2.0.0': '2026-01-07T23:30:00.000Z',
      },
    },
  },
};

describe('minimum release age', () => {
  it('uses seven days by default and rejects negative or non-integer values', () => {
    expect(DEFAULT_MINIMUM_RELEASE_AGE_DAYS).toBe(7);
    expect(MAX_MINIMUM_RELEASE_AGE_DAYS).toBe(99_000_000);
    expect(readMinimumReleaseAgeDays(undefined)).toBe(7);
    expect(readMinimumReleaseAgeDays(-1)).toBe(7);
    expect(readMinimumReleaseAgeDays(1.5)).toBe(7);
    expect(readMinimumReleaseAgeDays(Number.NaN)).toBe(7);
    expect(readMinimumReleaseAgeDays('7')).toBe(7);
    expect(readMinimumReleaseAgeDays(null)).toBe(7);
    expect(readMinimumReleaseAgeDays(99_000_001)).toBe(7);
    expect(readMinimumReleaseAgeDays(100_000_000)).toBe(7);
  });

  it('honors zero as the disabled value', () => {
    expect(readMinimumReleaseAgeDays(0)).toBe(0);
    expect(classifyVersionReleaseAge(
      '2.0.0',
      metadata.result.publishTimes,
      0,
      Date.parse('2026-01-07T23:30:00.000Z') - 1,
    )).toEqual({ kind: 'accepted' });
  });

  it('accepts a release at the exact boundary and holds it back just before it', () => {
    const boundary = Date.parse('2026-01-01T23:30:00.000Z') + 7 * 24 * 60 * 60 * 1000;

    expect(classifyVersionReleaseAge('1.1.0', metadata.result.publishTimes, 7, boundary))
      .toEqual({ kind: 'accepted' });
    expect(classifyVersionReleaseAge('1.1.0', metadata.result.publishTimes, 7, boundary - 1))
      .toEqual({
        kind: 'held-back',
        version: '1.1.0',
        eligibleAt: '2026-01-08T23:30:00.000Z',
      });
  });

  it('surfaces unknown age without blocking when publish times are unavailable or incomplete', () => {
    expect(classifyVersionReleaseAge(
      '2.0.0',
      { kind: 'not-provided' },
      7,
      Date.parse('2026-01-08T23:30:00.000Z'),
    )).toEqual({ kind: 'unknown', version: '2.0.0' });
    expect(classifyVersionReleaseAge(
      '3.0.0',
      metadata.result.publishTimes,
      7,
      Date.parse('2026-01-08T23:30:00.000Z'),
    )).toEqual({ kind: 'unknown', version: '3.0.0' });
    expect(classifyVersionReleaseAge(
      '3.0.0',
      { kind: 'provided', byVersion: { '3.0.0': 'not-a-date' } },
      7,
      Date.parse('2026-01-08T23:30:00.000Z'),
    )).toEqual({ kind: 'unknown', version: '3.0.0' });
    expect(classifyVersionReleaseAge(
      '4.0.0',
      { kind: 'provided', byVersion: { '4.0.0': '+275760-09-13T00:00:00.000Z' } },
      7,
      0,
    )).toEqual({ kind: 'unknown', version: '4.0.0' });
  });

  it('distinguishes an accepted NCU version from a newer held-back dist-tag', () => {
    expect(resolveUpdateReleaseAge(
      '^1.0.0',
      '1.1.0',
      metadata,
      7,
      Date.parse('2026-01-09T00:00:00.000Z'),
    )).toEqual({
      kind: 'held-back',
      version: '2.0.0',
      eligibleAt: '2026-01-14T23:30:00.000Z',
    });
  });

  it('marks an accepted update unknown when its metadata has no publish time', () => {
    expect(resolveUpdateReleaseAge(
      '^1.0.0',
      '1.1.0',
      {
        kind: 'success',
        result: {
          versions: ['1.1.0', '2.0.0'],
          distTags: { latest: '2.0.0' },
          publishTimes: { kind: 'not-provided' },
        },
      },
      7,
      Date.parse('2026-01-08T00:00:00.000Z'),
    )).toEqual({ kind: 'unknown', version: '1.1.0' });
  });

  it('does not block an update when metadata fetching fails', () => {
    expect(resolveUpdateReleaseAge(
      '^1.0.0',
      '1.1.0',
      { kind: 'timeout', timeoutMs: 15000 },
      7,
    )).toEqual({ kind: 'unknown', version: '1.1.0' });
  });
});
