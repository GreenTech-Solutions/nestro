import { AsyncLocalStorage } from 'node:async_hooks';

const operationMemo = new AsyncLocalStorage<Map<string, Promise<unknown>>>();

/** Runs one operation with registry configuration sources cached per package file; a nested call joins the enclosing memo. */
export function runWithRegistryConfigMemo<T>(operation: () => Promise<T>): Promise<T> {
  return operationMemo.getStore() === undefined
    ? operationMemo.run(new Map(), operation)
    : operation();
}

/** Inside runWithRegistryConfigMemo() each (kind, package file) reads once; outside it every call reads afresh. */
export function memoizeRegistrySource<T>(
  kind: 'npmrc' | 'bun' | 'yarn',
  packageFilePath: string | undefined,
  read: () => Promise<T>,
): Promise<T> {
  const memo = operationMemo.getStore();
  if (memo === undefined) {
    return read();
  }

  const key = kind + '\u0000' + (packageFilePath ?? '');
  const existing = memo.get(key);
  if (existing !== undefined) {
    return existing as Promise<T>;
  }
  const pending = Promise.resolve().then(read);
  memo.set(key, pending);
  return pending;
}