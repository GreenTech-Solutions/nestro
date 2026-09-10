import { OperationCoordinator } from './operationCoordinator';

/** One bounded root operation's outcome, kept in input order by runRootOperations(). */
export type RootOperationResult<TResult>
  = | { readonly status: 'success'; readonly value: TResult }
    | { readonly status: 'failure'; readonly error: unknown }
    | { readonly status: 'cancelled' };

export interface RootOperationRun<TResult> {
  /** Resolves with a stable cancelled snapshot as soon as the signal aborts. */
  readonly result: Promise<readonly RootOperationResult<TResult>[]>;
  /** Resolves only after every scheduled operation has actually settled. */
  readonly settled: Promise<readonly RootOperationResult<TResult>[]>;
}

function cancelledResults<TResult>(count: number): readonly RootOperationResult<TResult>[] {
  return Array.from({ length: count }, () => ({ status: 'cancelled' as const }));
}

function materializeResults<TResult>(
  results: readonly (RootOperationResult<TResult> | undefined)[],
): readonly RootOperationResult<TResult>[] {
  return results.map(result => result ?? { status: 'cancelled' });
}

/**
 * Starts bounded root work and separates prompt cancellation from actual settlement.
 * Started workers keep their coordinator slot and key until their promise settles.
 */
export function startRootOperations<TItem, TResult>(
  items: readonly TItem[],
  keyOf: (item: TItem) => string,
  coordinator: OperationCoordinator,
  signal: AbortSignal,
  worker: (item: TItem, signal: AbortSignal) => Promise<TResult>,
): RootOperationRun<TResult> {
  if (items.length === 0) {
    const empty: readonly RootOperationResult<TResult>[] = [];
    return { result: Promise.resolve(empty), settled: Promise.resolve(empty) };
  }

  const results: Array<RootOperationResult<TResult> | undefined> = new Array(items.length);
  const operations = items.map((item, index) => coordinator.runExclusive(keyOf(item), async () => {
    if (signal.aborted) {
      results[index] = { status: 'cancelled' };
      return;
    }

    try {
      const value = await worker(item, signal);
      results[index] = signal.aborted
        ? { status: 'cancelled' }
        : { status: 'success', value };
    }
    catch (error) {
      results[index] = signal.aborted
        ? { status: 'cancelled' }
        : { status: 'failure', error };
    }
  }).catch((error: unknown) => {
    // Keep an unexpected coordinator rejection contained as well as worker failures.
    results[index] = signal.aborted
      ? { status: 'cancelled' }
      : { status: 'failure', error };
  }));
  const settled = Promise.all(operations).then(() => materializeResults(results));

  let removeAbortListener: (() => void) | undefined;
  const cancelled = new Promise<readonly RootOperationResult<TResult>[]>((resolve) => {
    const onAbort = (): void => resolve(cancelledResults<TResult>(items.length));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  });

  const result = Promise.race([settled, cancelled]).finally(() => {
    removeAbortListener?.();
  });
  return { result, settled };
}

/**
 * Runs independent root operations through a keyed, bounded coordinator.
 * A cancelled operation never starts queued work, and every result retains input order.
 */
export async function runRootOperations<TItem, TResult>(
  items: readonly TItem[],
  keyOf: (item: TItem) => string,
  coordinator: OperationCoordinator,
  signal: AbortSignal,
  worker: (item: TItem, signal: AbortSignal) => Promise<TResult>,
): Promise<readonly RootOperationResult<TResult>[]> {
  return (await startRootOperations(items, keyOf, coordinator, signal, worker).settled);
}