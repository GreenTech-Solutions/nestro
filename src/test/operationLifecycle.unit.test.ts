import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { OperationLifecycle } from '../providers/operationLifecycle';

const progressOptions: vscode.ProgressOptions = {
  location: vscode.ProgressLocation.Notification,
  title: 'Operation',
  cancellable: true,
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('OperationLifecycle', () => {
  it('keeps current runs tied to their generation and snapshot', () => {
    const lifecycle = new OperationLifecycle<'load'>('load');
    const first = lifecycle.start(4);

    expect(lifecycle.isCurrent(first, 4, true)).toBe(true);
    expect(lifecycle.isCurrent(first, 5, true)).toBe(false);
    expect(lifecycle.isCurrent(first, 4, false)).toBe(false);

    const replacement = lifecycle.start(5);

    expect(first.abortController.signal.aborted).toBe(true);
    expect(lifecycle.isCurrent(first, 4, true)).toBe(false);
    expect(replacement.generation).toBeGreaterThan(first.generation);
    expect(lifecycle.isCurrent(replacement, 5, true)).toBe(true);

    lifecycle.cancel();

    expect(replacement.abortController.signal.aborted).toBe(true);
    expect(lifecycle.isCurrent(replacement, 5, true)).toBe(false);
    expect(lifecycle.cancel()).toBeUndefined();
  });

  it('tracks only the current completion and finishes only its owner', async () => {
    const lifecycle = new OperationLifecycle<'update'>('update');
    const stale = lifecycle.start(1);
    const current = lifecycle.start(2);
    const completion = deferred();

    lifecycle.trackCompletion(stale, Promise.resolve());
    lifecycle.trackCompletion(current, completion.promise);
    const waiting = lifecycle.waitForCurrent();
    completion.resolve();
    await waiting;

    expect(lifecycle.finish(stale)).toBe(false);
    expect(lifecycle.finish(current)).toBe(true);
    expect(lifecycle.finish(current)).toBe(false);
  });

  it('waits for completion or resolves when its signal is cancelled', async () => {
    const lifecycle = new OperationLifecycle<'load'>('load');
    const idleController = new AbortController();
    idleController.abort();

    await lifecycle.waitForCurrent(idleController.signal);
    await lifecycle.waitForCurrent();

    const operation = lifecycle.start(1);
    const completion = deferred();
    lifecycle.trackCompletion(operation, completion.promise);
    const cancellation = new AbortController();
    const waiting = lifecycle.waitForCurrent(cancellation.signal);

    cancellation.abort();
    await waiting;
    completion.resolve();
    await completion.promise;
    expect(cancellation.signal.aborted).toBe(true);
  });

  it('settles rejected completions without leaking a rejection', async () => {
    const lifecycle = new OperationLifecycle<'load'>('load');
    const operation = lifecycle.start(1);

    lifecycle.trackCompletion(operation, Promise.reject(new Error('load failed')));

    await expect(lifecycle.waitForCurrent()).resolves.toBeUndefined();
  });

  it('runs a progress task and disposes its cancellation listener', async () => {
    const lifecycle = new OperationLifecycle<'audit'>('audit');
    const cancel = vi.fn();
    const dispose = vi.fn();
    let listener: (() => void) | undefined;
    vi.mocked(vscode.window.withProgress).mockImplementationOnce((_options, task) => task(
      { report: vi.fn() },
      {
        isCancellationRequested: false,
        onCancellationRequested: vi.fn((callback: (event: void) => unknown) => {
          listener = () => callback(undefined);
          return { dispose };
        }),
      },
    ));

    const result = await lifecycle.withProgress(
      progressOptions,
      (): Promise<string> => {
        listener?.();
        return Promise.resolve('finished');
      },
      cancel,
    );

    expect(result).toBe('finished');
    expect(cancel).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('honours a token cancelled before the task begins', async () => {
    const lifecycle = new OperationLifecycle<'audit'>('audit');
    const cancel = vi.fn();
    const dispose = vi.fn();
    const task = vi.fn(() => Promise.resolve('finished'));
    vi.mocked(vscode.window.withProgress).mockImplementationOnce((_options, runTask) => runTask(
      { report: vi.fn() },
      {
        isCancellationRequested: true,
        onCancellationRequested: vi.fn(() => ({ dispose })),
      },
    ));

    await lifecycle.withProgress(progressOptions, task, cancel);

    expect(cancel).toHaveBeenCalledOnce();
    expect(task).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });
});