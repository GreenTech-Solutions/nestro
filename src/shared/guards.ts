import { compareCodeUnits } from './compare';

/** A plain JSON-style object: not null and not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The string itself when it has non-whitespace content, otherwise undefined. */
export function readRequiredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** True when the object's own keys are exactly `expected`, in any order. */
export function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const required = [...expected].sort(compareCodeUnits);
  return actual.length === required.length && actual.every((key, index) => key === required[index]);
}