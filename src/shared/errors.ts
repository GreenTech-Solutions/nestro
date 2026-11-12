/** The message of an `Error`, or the string form of anything else thrown. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A `; stderr: …` suffix for a failure message, empty when stderr has no content. */
export function describeStderr(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed === '' ? '' : `; stderr: ${trimmed}`;
}