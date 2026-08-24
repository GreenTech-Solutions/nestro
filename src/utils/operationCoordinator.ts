/**
 * Serializes package-project mutations by canonical project-root key (`ARC-01`).
 *
 * Guarantees:
 * - Two operations sharing a key never run their bodies concurrently; the later one
 *   waits for the earlier one to fully finish (including its own release) before it
 *   starts.
 * - Operations across different keys can run concurrently, bounded by `concurrencyCap`
 *   shared across every key — an unbounded number of independent project roots can
 *   never all execute their mutation at once.
 * - `runManyExclusive()` acquires every key it is given in the same deterministic sort
 *   order every caller uses, so two multi-key operations can never form a circular
 *   wait — the classic lock-ordering deadlock-avoidance argument.
 * - A throwing or cancelled operation still releases every key lock and concurrency
 *   slot it held: acquisition and release are paired through `finally`, not through the
 *   operation completing successfully.
 */
export class OperationCoordinator {
  private readonly keyQueues = new Map<string, Promise<unknown>>();
  private availableSlots: number;
  private readonly slotWaiters: (() => void)[] = [];

  constructor(private readonly concurrencyCap: number) {
    if (!Number.isInteger(concurrencyCap) || concurrencyCap < 1) {
      throw new Error('concurrencyCap must be a positive integer.');
    }
    this.availableSlots = concurrencyCap;
  }

  /** Run `fn` exclusively for one key. Equivalent to `runManyExclusive([key], fn)`. */
  runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.runManyExclusive([key], fn);
  }

  /**
   * Run `fn` exclusively across every key in `keys` (deduplicated), holding all of
   * them for the full duration of `fn`. Keys are acquired in ascending sort order —
   * never the caller-supplied order — which is what makes concurrent multi-key
   * acquisitions deadlock-free.
   */
  async runManyExclusive<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> {
    // Code-unit order, not locale collation — must agree with `Set`'s identity so two
    // distinct keys never compare equal and destabilize the shared acquisition order.
    const sortedKeys = [...new Set(keys)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const releases: (() => void)[] = [];
    try {
      for (const key of sortedKeys) {
        releases.push(await this.acquireKey(key));
      }
      await this.acquireSlot();
      try {
        return await fn();
      }
      finally {
        this.releaseSlot();
      }
    }
    finally {
      // Release in reverse acquisition order; irrelevant for correctness (the
      // per-key chains are independent) but keeps unwind order intuitive. `slice()`
      // first so this never mutates `releases` in place.
      for (const release of releases.slice().reverse()) {
        release();
      }
    }
  }

  /**
   * Resolve once every earlier holder of `key` has released, then claim the key for
   * the caller. Returns a release callback the caller must call exactly once, from a
   * `finally`, regardless of whether its own work succeeded.
   */
  private async acquireKey(key: string): Promise<() => void> {
    let releaseTurn!: () => void;
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const previous = this.keyQueues.get(key) ?? Promise.resolve();
    // The next caller for this key chains onto `chained`, which only resolves once
    // both the previous holder finished AND this caller releases below.
    const chained = previous.then(() => turn);
    this.keyQueues.set(key, chained);
    await previous;
    return () => {
      releaseTurn();
      // Only the last-registered chain for this key may clear the map entry; an
      // intervening caller already replaced it with its own chain.
      if (this.keyQueues.get(key) === chained) {
        this.keyQueues.delete(key);
      }
    };
  }

  private acquireSlot(): Promise<void> {
    if (this.availableSlots > 0) {
      this.availableSlots -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.slotWaiters.push(resolve);
    });
  }

  private releaseSlot(): void {
    const next = this.slotWaiters.shift();
    if (next !== undefined) {
      // Hand the slot directly to the next waiter; `availableSlots` is unchanged
      // because it is immediately consumed rather than returned to the pool.
      next();
      return;
    }
    this.availableSlots += 1;
  }
}

/**
 * Maximum number of independent project-root mutations allowed to execute at once;
 * a project root beyond the cap queues for a free slot instead of starting immediately.
 * Benchmarked: caps 4 through 12 were statistically indistinguishable given run-to-run
 * variance, and 8 was picked from within that range.
 */
export const MUTATION_CONCURRENCY_CAP = 8;

/** Shared coordinator instance used by every command that mutates a package project. */
export const mutationCoordinator = new OperationCoordinator(MUTATION_CONCURRENCY_CAP);