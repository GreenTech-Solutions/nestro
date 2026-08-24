import { describe, expect, it } from 'vitest';
import { MUTATION_CONCURRENCY_CAP, mutationCoordinator, OperationCoordinator } from '../utils/operationCoordinator';

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

/**
 * Flush the microtask queue so pending `.then()` chains settle before the next
 * assertion. `OperationCoordinator` chains several `await`s per key/slot acquisition
 * (one per `acquireKey()` call plus one for `acquireSlot()`), each of which costs a
 * real microtask tick even when the awaited promise is already resolved — so this
 * drains generously many ticks rather than guessing an exact count.
 */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 50; tick++) {
    await Promise.resolve();
  }
}

describe('OperationCoordinator', () => {
  describe('runExclusive()', () => {
    it('serializes two operations on the same key: the second never starts before the first releases', async () => {
      const coordinator = new OperationCoordinator(4);
      const order: string[] = [];
      const first = createDeferred();

      const opA = coordinator.runExclusive('root-a', async () => {
        order.push('a:enter');
        await first.promise;
        order.push('a:exit');
      });
      // Give opA's `runExclusive` call a chance to actually acquire the key before opB
      // is issued, so the ordering below reflects real contention, not call order.
      await flush();
      const opB = coordinator.runExclusive('root-a', () => {
        order.push('b:enter');
        order.push('b:exit');
        return Promise.resolve();
      });

      // opB must not have entered while opA is still holding the same key.
      await flush();
      expect(order).toEqual(['a:enter']);

      first.resolve();
      await opA;
      await opB;

      expect(order).toEqual(['a:enter', 'a:exit', 'b:enter', 'b:exit']);
    });

    it('lets operations on different keys run concurrently', async () => {
      const coordinator = new OperationCoordinator(4);
      const order: string[] = [];
      const gateA = createDeferred();
      const gateB = createDeferred();

      const opA = coordinator.runExclusive('root-a', async () => {
        order.push('a:enter');
        await gateA.promise;
        order.push('a:exit');
      });
      const opB = coordinator.runExclusive('root-b', async () => {
        order.push('b:enter');
        await gateB.promise;
        order.push('b:exit');
      });

      await flush();
      // Both entered before either released — true concurrency across distinct keys.
      expect(order).toEqual(['a:enter', 'b:enter']);

      gateB.resolve();
      await opB;
      gateA.resolve();
      await opA;

      expect(order).toEqual(['a:enter', 'b:enter', 'b:exit', 'a:exit']);
    });

    it('releases the key lock when the operation throws, so a queued same-key operation still runs', async () => {
      const coordinator = new OperationCoordinator(4);
      const order: string[] = [];

      const opA = coordinator.runExclusive('root-a', () => {
        order.push('a:enter');
        throw new Error('boom');
      });
      await expect(opA).rejects.toThrow('boom');

      const opB = coordinator.runExclusive('root-a', () => {
        order.push('b:enter');
        return Promise.resolve();
      });
      await opB;

      expect(order).toEqual(['a:enter', 'b:enter']);
    });

    it('releases the concurrency slot when the operation throws, so an independent-key queued operation still runs', async () => {
      const coordinator = new OperationCoordinator(1);

      await expect(coordinator.runExclusive('root-a', () => {
        throw new Error('boom');
      })).rejects.toThrow('boom');

      // With a cap of 1, this would hang forever if the failed operation above had not
      // released its slot.
      const result = await coordinator.runExclusive('root-b', () => Promise.resolve('ok'));
      expect(result).toBe('ok');
    });

    it('propagates the resolved value of `fn`', async () => {
      const coordinator = new OperationCoordinator(2);

      const result = await coordinator.runExclusive('root-a', () => Promise.resolve(42));

      expect(result).toBe(42);
    });
  });

  describe('concurrency cap', () => {
    it('never lets more than `concurrencyCap` independent keys execute at once', async () => {
      const cap = 2;
      const coordinator = new OperationCoordinator(cap);
      const keyCount = 5;
      let active = 0;
      let peak = 0;
      const gates = Array.from({ length: keyCount }, () => createDeferred());

      const operations = Array.from({ length: keyCount }, (_, index) =>
        coordinator.runExclusive(`root-${index}`, async () => {
          active += 1;
          peak = Math.max(peak, active);
          await gates[index].promise;
          active -= 1;
        }));

      await flush();
      expect(active).toBe(cap);

      // Release one at a time; active count must never exceed the cap even as slots
      // free up and queued operations take their place.
      for (const gate of gates) {
        gate.resolve();
        await flush();
        expect(active).toBeLessThanOrEqual(cap);
      }

      await Promise.all(operations);
      expect(peak).toBe(cap);
    });

    it('lets same-key serialization proceed independently of the concurrency cap', async () => {
      // A cap of 1 must not prevent a *single* key's own queue from making progress;
      // it only bounds how many *distinct* keys run at once.
      const coordinator = new OperationCoordinator(1);
      const order: string[] = [];

      await coordinator.runExclusive('root-a', () => {
        order.push('first');
        return Promise.resolve();
      });
      await coordinator.runExclusive('root-a', () => {
        order.push('second');
        return Promise.resolve();
      });

      expect(order).toEqual(['first', 'second']);
    });
  });

  describe('runManyExclusive()', () => {
    it('holds every given key for the full duration of the operation', async () => {
      const coordinator = new OperationCoordinator(4);
      const order: string[] = [];
      const gate = createDeferred();

      const bulk = coordinator.runManyExclusive(['root-a', 'root-b'], async () => {
        order.push('bulk:enter');
        await gate.promise;
        order.push('bulk:exit');
      });
      await flush();

      // A single-key operation on either root must wait behind the bulk operation.
      const singleA = coordinator.runExclusive('root-a', () => {
        order.push('single-a');
        return Promise.resolve();
      });
      const singleB = coordinator.runExclusive('root-b', () => {
        order.push('single-b');
        return Promise.resolve();
      });
      await flush();
      expect(order).toEqual(['bulk:enter']);

      gate.resolve();
      await bulk;
      await singleA;
      await singleB;

      // Both single-key operations ran only after the bulk operation released both of
      // its keys; their order relative to *each other* is an implementation detail
      // (release order), not part of the contract.
      expect(order.slice(0, 2)).toEqual(['bulk:enter', 'bulk:exit']);
      expect(order.slice(2).sort((left, right) => left.localeCompare(right))).toEqual(['single-a', 'single-b']);
    });

    it('does not block an unrelated key while holding a different multi-key set', async () => {
      const coordinator = new OperationCoordinator(4);
      const order: string[] = [];
      const gate = createDeferred();

      const bulk = coordinator.runManyExclusive(['root-a', 'root-b'], async () => {
        order.push('bulk:enter');
        await gate.promise;
        order.push('bulk:exit');
      });
      await flush();

      const unrelated = coordinator.runExclusive('root-c', () => {
        order.push('unrelated');
        return Promise.resolve();
      });
      await unrelated;

      gate.resolve();
      await bulk;

      expect(order).toEqual(['bulk:enter', 'unrelated', 'bulk:exit']);
    });

    it('dedupes repeated keys instead of deadlocking on itself', async () => {
      const coordinator = new OperationCoordinator(4);

      const result = await coordinator.runManyExclusive(['root-a', 'root-a', 'root-a'], () => Promise.resolve('done'));

      expect(result).toBe('done');
    });

    it('runs with just the concurrency slot when given no keys', async () => {
      const coordinator = new OperationCoordinator(4);

      const result = await coordinator.runManyExclusive([], () => Promise.resolve('done'));

      expect(result).toBe('done');
    });

    it('releases every held key when the operation throws', async () => {
      const coordinator = new OperationCoordinator(4);

      await expect(coordinator.runManyExclusive(['root-a', 'root-b'], () => {
        throw new Error('boom');
      })).rejects.toThrow('boom');

      const resultA = await coordinator.runExclusive('root-a', () => Promise.resolve('a'));
      const resultB = await coordinator.runExclusive('root-b', () => Promise.resolve('b'));
      expect(resultA).toBe('a');
      expect(resultB).toBe('b');
    });

    it('acquires overlapping multi-key sets in the same sorted order regardless of caller-supplied order, avoiding deadlock', async () => {
      const coordinator = new OperationCoordinator(4);
      const order: string[] = [];
      const gate1 = createDeferred();
      const gate2 = createDeferred();

      // Two bulk operations request the SAME two keys in opposite order. If keys were
      // acquired in caller-supplied order rather than a shared sort order, this could
      // deadlock (op1 holds 'root-a' waiting for 'root-b' while op2 holds 'root-b'
      // waiting for 'root-a'). Acquiring in a shared sorted order makes that
      // impossible: whichever operation acquires the first sorted key wins the race
      // for the second one too, since nobody ever holds a key while blocked on an
      // earlier-sorted one.
      const op1 = coordinator.runManyExclusive(['root-a', 'root-b'], async () => {
        order.push('op1:enter');
        await gate1.promise;
        order.push('op1:exit');
      });
      const op2 = coordinator.runManyExclusive(['root-b', 'root-a'], async () => {
        order.push('op2:enter');
        await gate2.promise;
        order.push('op2:exit');
      });

      await flush();
      // Exactly one of the two has entered; the other is queued behind it on the
      // shared key, not deadlocked.
      expect(order).toHaveLength(1);

      gate1.resolve();
      gate2.resolve();
      await Promise.all([op1, op2]);

      expect(order).toEqual(['op1:enter', 'op1:exit', 'op2:enter', 'op2:exit']);
    });

    it('acquires two keys that localeCompare treats as equal in a fixed order, avoiding a permanent deadlock', async () => {
      const coordinator = new OperationCoordinator(4);
      const order: string[] = [];
      const gate1 = createDeferred();
      const gate2 = createDeferred();

      // Composed 'é' (one code point) vs. decomposed 'e' + combining acute accent (two
      // code points): ICU collation treats these as canonically equivalent and
      // `localeCompare` returns 0 for them, even though they are distinct strings.
      const nfc = 'root-café';
      const nfd = 'root-café';
      expect(nfc.localeCompare(nfd)).toBe(0);

      const op1 = coordinator.runManyExclusive([nfc, nfd], async () => {
        order.push('op1:enter');
        await gate1.promise;
        order.push('op1:exit');
      });
      const op2 = coordinator.runManyExclusive([nfd, nfc], async () => {
        order.push('op2:enter');
        await gate2.promise;
        order.push('op2:exit');
      });

      await flush();
      // A comparator without a strict total order over these two keys would let both
      // acquisitions proceed in caller-supplied order and deadlock here permanently.
      expect(order).toHaveLength(1);

      gate1.resolve();
      gate2.resolve();
      await Promise.all([op1, op2]);

      expect(order).toEqual(['op1:enter', 'op1:exit', 'op2:enter', 'op2:exit']);
    });
  });

  describe('constructor', () => {
    it.each([0, -1, 1.5, Number.NaN])('rejects a non-positive-integer concurrency cap (%s)', (cap) => {
      expect(() => new OperationCoordinator(cap)).toThrow('concurrencyCap must be a positive integer.');
    });

    it('accepts a positive integer cap', () => {
      expect(() => new OperationCoordinator(1)).not.toThrow();
    });
  });

  describe('shared singleton', () => {
    it('exports one coordinator instance sized to the benchmarked cap', () => {
      expect(mutationCoordinator).toBeInstanceOf(OperationCoordinator);
      expect(MUTATION_CONCURRENCY_CAP).toBeGreaterThan(0);
      expect(Number.isInteger(MUTATION_CONCURRENCY_CAP)).toBe(true);
    });

    it('bounds concurrent independent-key operations at MUTATION_CONCURRENCY_CAP', async () => {
      let active = 0;
      let peak = 0;
      const gates = Array.from({ length: MUTATION_CONCURRENCY_CAP + 3 }, () => createDeferred());

      const operations = gates.map((gate, index) =>
        mutationCoordinator.runExclusive(`singleton-root-${index}`, async () => {
          active += 1;
          peak = Math.max(peak, active);
          await gate.promise;
          active -= 1;
        }));

      await flush();
      expect(active).toBe(MUTATION_CONCURRENCY_CAP);

      gates.forEach(gate => gate.resolve());
      await Promise.all(operations);

      expect(peak).toBe(MUTATION_CONCURRENCY_CAP);
    });
  });
});