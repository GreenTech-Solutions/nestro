export const UPDATE_TARGETS = ['latest', 'greatest', 'minor', 'patch'] as const;
export type UpdateTarget = typeof UPDATE_TARGETS[number];

export const FILTER_TYPES = ['all', 'hasUpdates', 'patch', 'minor', 'breaking'] as const;
export type FilterType = typeof FILTER_TYPES[number];

export const DEFAULT_MINIMUM_RELEASE_AGE_DAYS = 7;
export const MAX_MINIMUM_RELEASE_AGE_DAYS = 99_000_000;

export function isUpdateTarget(value: unknown): value is UpdateTarget {
  return typeof value === 'string' && (UPDATE_TARGETS as readonly string[]).includes(value);
}

export function isFilterType(value: unknown): value is FilterType {
  return typeof value === 'string' && (FILTER_TYPES as readonly string[]).includes(value);
}

/** A whole number in `0..MAX_MINIMUM_RELEASE_AGE_DAYS` is kept; anything else becomes the default. */
export function readMinimumReleaseAgeDays(value: unknown): number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    && value <= MAX_MINIMUM_RELEASE_AGE_DAYS
    ? value
    : DEFAULT_MINIMUM_RELEASE_AGE_DAYS;
}