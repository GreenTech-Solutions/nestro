import * as vscode from 'vscode';

/**
 * Mirrors the listener-registration / `settled`-guard / dispose pattern in
 * `runShellTaskAndWait()` (`src/utils/shellTask.ts`), generalized to accept a
 * prebuilt `vscode.Task` instead of a `ShellTaskCommand`.
 *
 * `runShellTaskAndWait()` always builds a `ShellExecution` task internally, so
 * it cannot be driven through a `CustomExecution` task directly. This helper
 * exercises the identical event-race handling against an arbitrary task
 * shape instead, so it can be pointed at `createNoProcessTask()` below.
 *
 * Note: the currently bundled VS Code versions (see `.vscode-test.mjs`) fire
 * `onDidEndTaskProcess` with `exitCode: undefined` even for `CustomExecution`
 * tasks and for `ShellExecution` tasks whose process never spawns at all —
 * contradicting the `tasks.onDidEndTaskProcess` doc comment ("This event
 * will not fire for tasks that don't execute an underlying process"),
 * confirmed empirically against several task shapes. `shellTask.ts`'s
 * `onDidEndTask`-without-a-preceding-`onDidEndTaskProcess` fallback
 * (`shellTask.ts:62-73`) therefore appears unreachable through genuine,
 * safely constructed tasks in these VS Code versions; this helper still
 * proves the outcome that fallback exists for — a task reporting no exit
 * code resolves as `undefined` instead of hanging — just via whichever of
 * the two events actually fires first.
 */
export async function awaitTaskOutcome(task: vscode.Task): Promise<number | undefined> {
  let execution: vscode.TaskExecution | undefined;
  const bufferedProcessEvents: vscode.TaskProcessEndEvent[] = [];
  const bufferedTaskEvents: vscode.TaskEndEvent[] = [];

  const completion = new Promise<number | undefined>((resolve, reject) => {
    let settled = false;
    let processListener: vscode.Disposable;
    let taskListener: vscode.Disposable;

    const finish = (exitCode: number | undefined): void => {
      if (settled) {
        return;
      }

      settled = true;
      processListener.dispose();
      taskListener.dispose();
      resolve(exitCode);
    };

    processListener = vscode.tasks.onDidEndTaskProcess((event) => {
      if (execution === undefined) {
        bufferedProcessEvents.push(event);
        return;
      }

      if (event.execution !== execution) {
        return;
      }

      finish(event.exitCode);
    });

    taskListener = vscode.tasks.onDidEndTask((event) => {
      if (execution === undefined) {
        bufferedTaskEvents.push(event);
        return;
      }

      if (event.execution !== execution) {
        return;
      }

      finish(undefined);
    });

    void (async (): Promise<void> => {
      try {
        execution = await vscode.tasks.executeTask(task);
      }
      catch (error) {
        processListener.dispose();
        taskListener.dispose();
        throw error;
      }

      const processEvent = bufferedProcessEvents.find(event => event.execution === execution);
      if (processEvent !== undefined) {
        finish(processEvent.exitCode);
        return;
      }

      if (bufferedTaskEvents.some(event => event.execution === execution)) {
        finish(undefined);
      }
    })().catch(reject);
  });

  return await completion;
}

/**
 * Resolves with the live `TaskExecution` once the task named `taskName` has an
 * OS process running. Subscribe **before** starting the task, or the event can
 * fire before the listener exists.
 *
 * `vscode.tasks.taskExecutions` is not a safe substitute. That array is the
 * extension host's own view and lists an execution as soon as `executeTask()`
 * is registered there, which happens before the main thread has spawned the
 * terminal. `terminate()` on a handle taken from it that early reaches a task
 * service that does not know the id yet: VS Code logs "Task to terminate not
 * found", the call is a silent no-op, and the process keeps running with no
 * end event ever arriving — the caller then hangs until its own timeout.
 * `onDidStartTaskProcess` is the first point at which both sides agree a live
 * process exists, so a terminate issued after it is always delivered.
 */
export function awaitTaskProcessStart(
  taskName: string,
  timeoutMs = 15000,
): Promise<vscode.TaskExecution> {
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      clearTimeout(timer);
      subscription.dispose();
    };

    const timer = setTimeout(() => {
      finish();
      reject(new Error(`Task "${taskName}" did not start a process within ${timeoutMs}ms.`));
    }, timeoutMs);

    const subscription = vscode.tasks.onDidStartTaskProcess((event) => {
      if (event.execution.task.name !== taskName) {
        return;
      }
      finish();
      resolve(event.execution);
    });
  });
}

/**
 * A task whose execution never spawns an OS process and reports no exit
 * code. `Pseudoterminal.onDidClose` is fired with no argument (`void`), not
 * `0`: a numeric close code is a real exit code as far as VS Code is
 * concerned and would make this fixture indistinguishable from a successful
 * task (see the `awaitTaskOutcome` doc comment above for why this still
 * observably fires `onDidEndTaskProcess`, just with `exitCode: undefined`).
 */
export function createNoProcessTask(name: string): vscode.Task {
  const task = new vscode.Task(
    { type: 'nestro-test-no-process' },
    vscode.TaskScope.Workspace,
    name,
    'Nestro Test',
    new vscode.CustomExecution(() => Promise.resolve(createInstantPseudoterminal())),
  );
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Never };
  return task;
}

function createInstantPseudoterminal(): vscode.Pseudoterminal {
  const writeEmitter = new vscode.EventEmitter<string>();
  const closeEmitter = new vscode.EventEmitter<void | number>();
  return {
    onDidWrite: writeEmitter.event,
    onDidClose: closeEmitter.event,
    open: () => closeEmitter.fire(undefined),
    close: () => {},
  };
}