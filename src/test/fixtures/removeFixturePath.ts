import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const REMOVE_DEADLINE_MS = 10000;
const REMOVE_RETRY_DELAY_MS = 100;
const RETRYABLE_REMOVE_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);

function isRetryableRemoveError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && RETRYABLE_REMOVE_CODES.has(code);
}

/**
 * Removes a fixture file or directory, retrying transient lock errors until a fixed deadline:
 * on Windows a VS Code watcher can briefly hold a handle on a just-closed workspace folder.
 * Past the deadline the original error surfaces instead of a hook timeout.
 */
export async function removeFixturePath(path: string): Promise<void> {
  const deadline = Date.now() + REMOVE_DEADLINE_MS;
  for (;;) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    }
    catch (err) {
      if (!isRetryableRemoveError(err) || Date.now() >= deadline) {
        throw err;
      }
      await delay(REMOVE_RETRY_DELAY_MS);
    }
  }
}