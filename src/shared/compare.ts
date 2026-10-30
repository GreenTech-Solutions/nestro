/** Deterministic code-unit ordering: identical on every machine, unlike `localeCompare`. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The distinct values in first-seen order. */
export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}