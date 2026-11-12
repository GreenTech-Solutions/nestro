import * as vscode from 'vscode';

export interface OperationRun<T> {
  readonly kind: T;
  readonly generation: number;
  readonly snapshotGeneration: number;
  readonly abortController: AbortController;
}

export class OperationLifecycle<T> {
  private generation = 0;
  private operation: OperationRun<T> | undefined;
  private completion: Promise<void> | undefined;

  constructor(private readonly kind: T) {}

  start(snapshotGeneration: number): OperationRun<T> {
    this.cancel();
    this.generation += 1;
    const operation: OperationRun<T> = {
      kind: this.kind,
      generation: this.generation,
      snapshotGeneration,
      abortController: new AbortController(),
    };
    this.operation = operation;
    return operation;
  }

  isCurrent(
    operation: OperationRun<T>,
    snapshotGeneration: number,
    isRunning: boolean,
  ): boolean {
    return this.operation === operation
      && operation.generation === this.generation
      && operation.snapshotGeneration === snapshotGeneration
      && isRunning
      && !operation.abortController.signal.aborted;
  }

  trackCompletion(operation: OperationRun<T>, completion: Promise<unknown>): void {
    if (this.operation !== operation) {
      return;
    }
    this.completion = completion.then(() => undefined, () => undefined);
  }

  waitForCurrent(signal?: AbortSignal): Promise<void> {
    const completion = this.completion;
    if (completion === undefined || signal === undefined) {
      return completion ?? Promise.resolve();
    }
    if (signal.aborted) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        signal.removeEventListener('abort', finish);
        resolve();
      };
      signal.addEventListener('abort', finish, { once: true });
      void completion.then(finish);
    });
  }

  finish(operation: OperationRun<T>): boolean {
    if (this.operation !== operation) {
      return false;
    }
    this.operation = undefined;
    this.completion = undefined;
    return true;
  }

  cancel(): OperationRun<T> | undefined {
    const operation = this.operation;
    if (operation === undefined) {
      return undefined;
    }
    this.operation = undefined;
    this.completion = undefined;
    this.generation += 1;
    operation.abortController.abort();
    return operation;
  }

  async withProgress<R>(
    options: vscode.ProgressOptions,
    task: (
      progress: vscode.Progress<{ message?: string; increment?: number }>,
      token: vscode.CancellationToken,
    ) => Promise<R>,
    onCancel: () => void,
  ): Promise<R> {
    return await vscode.window.withProgress(options, async (progress, token): Promise<R> => {
      const cancellation = token.onCancellationRequested(onCancel);
      try {
        if (token.isCancellationRequested) {
          onCancel();
        }
        return await task(progress, token);
      }
      finally {
        cancellation.dispose();
      }
    });
  }
}