/* eslint-disable @stylistic/eol-last */

import type { PackageMetadataOutcome, PublishTimes } from './metadataRegistry';
import { getUpdateType } from './versionUtils';

export const DEFAULT_MINIMUM_RELEASE_AGE_DAYS = 7;
export const MAX_MINIMUM_RELEASE_AGE_DAYS = 99_000_000;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export type ReleaseAgeState
  = | { readonly kind: 'accepted' }
    | { readonly kind: 'held-back'; readonly version: string; readonly eligibleAt: string }
    | { readonly kind: 'unknown'; readonly version?: string };

export function readMinimumReleaseAgeDays(value: unknown): number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    && value <= MAX_MINIMUM_RELEASE_AGE_DAYS
    ? value
    : DEFAULT_MINIMUM_RELEASE_AGE_DAYS;
}

export function classifyVersionReleaseAge(
  version: string,
  publishTimes: PublishTimes,
  minimumReleaseAgeDays: unknown,
  nowMs = Date.now(),
): ReleaseAgeState {
  const minimumDays = readMinimumReleaseAgeDays(minimumReleaseAgeDays);
  if (minimumDays === 0) {
    return { kind: 'accepted' };
  }
  if (publishTimes.kind !== 'provided') {
    return { kind: 'unknown', version };
  }

  const publishedAt = publishTimes.byVersion[version];
  const publishedAtMs = publishedAt === undefined ? Number.NaN : Date.parse(publishedAt);
  if (!Number.isFinite(publishedAtMs)) {
    return { kind: 'unknown', version };
  }

  const eligibleAtMs = publishedAtMs + minimumDays * MILLISECONDS_PER_DAY;
  if (nowMs >= eligibleAtMs) {
    return { kind: 'accepted' };
  }

  const eligibleAt = new Date(eligibleAtMs);
  if (!Number.isFinite(eligibleAt.getTime())) {
    return { kind: 'unknown', version };
  }

  return {
    kind: 'held-back',
    version,
    eligibleAt: eligibleAt.toISOString(),
  };
}

export function resolveUpdateReleaseAge(
  currentVersion: string,
  acceptedVersion: string | undefined,
  metadataOutcome: PackageMetadataOutcome | undefined,
  minimumReleaseAgeDays: unknown,
  nowMs = Date.now(),
): ReleaseAgeState {
  const minimumDays = readMinimumReleaseAgeDays(minimumReleaseAgeDays);
  if (minimumDays === 0) {
    return { kind: 'accepted' };
  }

  const metadata = metadataOutcome?.kind === 'success' ? metadataOutcome.result : undefined;
  const acceptedIsUpdate = acceptedVersion !== undefined
    && getUpdateType(currentVersion, acceptedVersion) !== 'none';
  if (acceptedIsUpdate) {
    const acceptedAge = metadata === undefined
      ? { kind: 'unknown' as const, version: acceptedVersion }
      : classifyVersionReleaseAge(acceptedVersion, metadata.publishTimes, minimumDays, nowMs);
    if (acceptedAge.kind !== 'accepted') {
      return acceptedAge;
    }
  }

  const realLatest = metadata?.distTags.latest;
  const latestIsNewer = realLatest !== undefined
    && getUpdateType(acceptedVersion ?? currentVersion, realLatest) !== 'none';
  if (!latestIsNewer) {
    return { kind: 'accepted' };
  }

  if (metadata === undefined) {
    return { kind: 'unknown', version: realLatest };
  }
  return classifyVersionReleaseAge(realLatest, metadata.publishTimes, minimumDays, nowMs);
}
