import * as vscode from 'vscode';

/**
 * Mirrors `runShellTaskAndWait()`'s listener/dispose pattern for a prebuilt `vscode.Task`,
 * since that function only builds `ShellExecution` tasks and cannot be pointed at
 * `createNoProcessTask()` below. The bundled VS Code fires `onDidEndTaskProcess` with
 * `exitCode: undefined` even for tasks whose process never spawns, so this exercises the
 * same undefined-exit-code fallback via whichever of the two end events fires first.
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
 * Resolves with the live `TaskExecution` once `taskName` has an OS process running. Subscribe
 * before starting the task, or the event can fire before the listener exists.
 *
 * `vscode.tasks.taskExecutions` is not a safe substitute: it lists an execution before the
 * terminal spawns, so a `terminate()` taken from it that early is a silent no-op and the
 * caller hangs. `onDidStartTaskProcess` is the first point a terminate is reliably delivered.
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
 * A task whose execution never spawns an OS process and reports no exit code:
 * `Pseudoterminal.onDidClose` fires with no argument (`void`), not `0`, since a numeric
 * close code would make this fixture indistinguishable from a successful task.
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