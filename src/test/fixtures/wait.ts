const DEFAULT_TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 50;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Polls until `condition` holds. Used instead of a fixed sleep for VS Code state
 * that becomes observable asynchronously, such as the workspace file index after
 * a folder is added.
 */
export async function waitUntil(
  condition: () => Promise<boolean>,
  description: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await condition()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}.`);
    }
    await delay(POLL_INTERVAL_MS);
  }
}