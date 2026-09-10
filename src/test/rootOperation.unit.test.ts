import { describe, expect, it, vi } from 'vitest';
import { OperationCoordinator } from '../utils/operationCoordinator';
import { runRootOperations, startRootOperations } from '../utils/rootOperation';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drains the microtask queue so pending coordinator acquisitions settle before an assertion. */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 50; tick++) {
    await Promise.resolve();
  }
}

describe('runRootOperations()', () => {
  it('returns an empty array without acquiring any coordinator slot', async () => {
    const coordinator = new OperationCoordinator(4);
    let called = false;

    const results = await runRootOperations(
      [] as readonly string[],
      key => key,
      coordinator,
      new AbortController().signal,
      () => {
        called = true;
        return Promise.resolve('unused');
      },
    );

    expect(results).toEqual([]);
    expect(called).toBe(false);
  });

  it('bounds concurrent items at the given cap while still running every item', async () => {
    const cap = 2;
    const coordinator = new OperationCoordinator(cap);
    const items = ['root-0', 'root-1', 'root-2', 'root-3', 'root-4'];
    let active = 0;
    let peak = 0;
    const gates = items.map(() => createDeferred<void>());

    const run = runRootOperations(
      items,
      key => key,
      coordinator,
      new AbortController().signal,
      async (item, _signal) => {
        active += 1;
        peak = Math.max(peak, active);
        await gates[items.indexOf(item)].promise;
        active -= 1;
        return item;
      },
    );

    await flush();
    expect(active).toBe(cap);

    for (const gate of gates) {
      gate.resolve();
      await flush();
      expect(active).toBeLessThanOrEqual(cap);
    }

    const results = await run;
    expect(peak).toBe(cap);
    expect(results.every(result => result.status === 'success')).toBe(true);
  });

  it('runs items with distinct keys concurrently', async () => {
    const coordinator = new OperationCoordinator(4);
    const order: string[] = [];
    const gateA = createDeferred<void>();
    const gateB = createDeferred<void>();

    const run = runRootOperations(
      ['root-a', 'root-b'],
      key => key,
      coordinator,
      new AbortController().signal,
      async (item) => {
        order.push(`${item}:enter`);
        await (item === 'root-a' ? gateA.promise : gateB.promise);
        order.push(`${item}:exit`);
        return item;
      },
    );

    await flush();
    expect(order).toEqual(['root-a:enter', 'root-b:enter']);

    gateB.resolve();
    await flush();
    gateA.resolve();
    await run;

    expect(order).toEqual(['root-a:enter', 'root-b:enter', 'root-b:exit', 'root-a:exit']);
  });

  it('serializes items that share the same coordinator key', async () => {
    const coordinator = new OperationCoordinator(4);
    const order: string[] = [];
    const gate = createDeferred<void>();

    const run = runRootOperations(
      ['first', 'second'],
      () => 'shared-root',
      coordinator,
      new AbortController().signal,
      async (item) => {
        order.push(`${item}:enter`);
        if (item === 'first') {
          await gate.promise;
        }
        order.push(`${item}:exit`);
        return item;
      },
    );

    await flush();
    // 'second' must not enter while 'first' still holds the shared key.
    expect(order).toEqual(['first:enter']);

    gate.resolve();
    await run;

    expect(order).toEqual(['first:enter', 'first:exit', 'second:enter', 'second:exit']);
  });

  it('keeps one failing item isolated from the others, in stable input order', async () => {
    const coordinator = new OperationCoordinator(4);
    const failure = new Error('root-1 failed');

    const results = await runRootOperations(
      ['root-0', 'root-1', 'root-2'],
      key => key,
      coordinator,
      new AbortController().signal,
      (item) => {
        if (item === 'root-1') {
          return Promise.reject(failure);
        }
        return Promise.resolve(`${item}-ok`);
      },
    );

    expect(results).toEqual([
      { status: 'success', value: 'root-0-ok' },
      { status: 'failure', error: failure },
      { status: 'success', value: 'root-2-ok' },
    ]);
  });

  it('returns results in input order even when later items finish first', async () => {
    const coordinator = new OperationCoordinator(4);
    const gateSlow = createDeferred<void>();

    const run = runRootOperations(
      ['slow', 'fast'],
      key => key,
      coordinator,
      new AbortController().signal,
      async (item) => {
        if (item === 'slow') {
          await gateSlow.promise;
        }
        return item;
      },
    );

    await flush();
    gateSlow.resolve();
    const results = await run;

    expect(results).toEqual([
      { status: 'success', value: 'slow' },
      { status: 'success', value: 'fast' },
    ]);
  });

  it('marks every item cancelled without calling its worker when the signal is already aborted', async () => {
    const coordinator = new OperationCoordinator(4);
    const controller = new AbortController();
    controller.abort();
    let calls = 0;

    const results = await runRootOperations(
      ['root-0', 'root-1'],
      key => key,
      coordinator,
      controller.signal,
      () => {
        calls += 1;
        return Promise.resolve('unused');
      },
    );

    expect(results).toEqual([{ status: 'cancelled' }, { status: 'cancelled' }]);
    expect(calls).toBe(0);
  });

  it('cancels items still queued behind the cap once the signal aborts mid-run, without starting them', async () => {
    const cap = 1;
    const coordinator = new OperationCoordinator(cap);
    const controller = new AbortController();
    const gate = createDeferred<void>();
    let secondCalled = false;

    const run = runRootOperations(
      ['root-0', 'root-1'],
      key => key,
      coordinator,
      controller.signal,
      async (item) => {
        if (item === 'root-0') {
          await gate.promise;
          return item;
        }
        secondCalled = true;
        return `${item}-queued`;
      },
    );

    await flush();
    controller.abort();
    gate.resolve();
    const results = await run;

    // The first item's work still runs to completion in the background, but its result
    // is discarded once the signal is aborted; the second, still queued behind the cap,
    // is skipped entirely and never calls its own worker.
    expect(results).toEqual([{ status: 'cancelled' }, { status: 'cancelled' }]);
    expect(secondCalled).toBe(false);
  });

  it('returns a cancellation snapshot before an in-flight worker settles', async () => {
    const coordinator = new OperationCoordinator(1);
    const controller = new AbortController();
    const gate = createDeferred<void>();
    let started = 0;
    let queuedStarted = false;
    const run = startRootOperations(
      ['root-0', 'root-1'],
      key => key,
      coordinator,
      controller.signal,
      async (item) => {
        started += 1;
        if (item === 'root-0') {
          await gate.promise;
          return item;
        }
        queuedStarted = true;
        return `${item}-queued`;
      },
    );

    await vi.waitFor(() => expect(started).toBe(1));
    controller.abort();
    await expect(run.result).resolves.toEqual([
      { status: 'cancelled' },
      { status: 'cancelled' },
    ]);
    expect(queuedStarted).toBe(false);

    gate.resolve();
    await run.settled;
    expect(started).toBe(1);
    expect(queuedStarted).toBe(false);
  });
});