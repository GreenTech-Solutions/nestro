import * as vscode from 'vscode';

export interface ShellTaskCommand {
  command: string | vscode.ShellQuotedString;
  args: (string | vscode.ShellQuotedString)[];
}

export type ShellTaskOutcome
  = | { readonly kind: 'ended'; readonly exitCode: number | undefined }
    | { readonly kind: 'cancelled' };

interface ShellTaskWaitState {
  readonly bufferedProcessEvents: vscode.TaskProcessEndEvent[];
  readonly bufferedTaskEvents: vscode.TaskEndEvent[];
  readonly listeners: vscode.Disposable[];
  readonly resolve: (outcome: ShellTaskOutcome) => void;
  readonly reject: (error: unknown) => void;
  execution: vscode.TaskExecution | undefined;
  settled: boolean;
  cancelled: boolean;
}

export async function runShellTaskAndWait(
  shellCommand: ShellTaskCommand,
  taskName: string,
  cwd?: string,
): Promise<ShellTaskOutcome> {
  const task = new vscode.Task(
    { type: 'shell' },
    vscode.TaskScope.Workspace,
    taskName,
    'Nestro',
    new vscode.ShellExecution(
      shellCommand.command,
      shellCommand.args,
      cwd === undefined ? undefined : { cwd },
    ),
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.New,
  };

  return await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: taskName, cancellable: true },
    (_progress, token) => waitForShellTask(task, token),
  );
}

function waitForShellTask(task: vscode.Task, token: vscode.CancellationToken): Promise<ShellTaskOutcome> {
  return new Promise((resolve, reject) => {
    const state: ShellTaskWaitState = {
      bufferedProcessEvents: [],
      bufferedTaskEvents: [],
      listeners: [],
      resolve,
      reject,
      execution: undefined,
      settled: false,
      cancelled: false,
    };
    if (token.isCancellationRequested) {
      settleShellTask(state, { kind: 'cancelled' });
      return;
    }
    state.listeners.push(
      vscode.tasks.onDidEndTaskProcess(event => handleProcessEnd(state, event)),
      vscode.tasks.onDidEndTask(event => handleTaskEnd(state, event)),
      token.onCancellationRequested(() => cancelShellTask(state)),
    );
    void startShellTask(task, state).catch(error => rejectShellTask(state, error));
  });
}

async function startShellTask(task: vscode.Task, state: ShellTaskWaitState): Promise<void> {
  state.execution = await vscode.tasks.executeTask(task);
  if (state.cancelled) {
    state.execution.terminate();
    return;
  }
  const processEvent = state.bufferedProcessEvents.find(event => event.execution === state.execution);
  if (processEvent !== undefined) {
    finishProcessEnd(state, processEvent.exitCode);
    return;
  }
  if (state.bufferedTaskEvents.some(event => event.execution === state.execution)) {
    finishProcessEnd(state, undefined);
  }
}

function handleProcessEnd(state: ShellTaskWaitState, event: vscode.TaskProcessEndEvent): void {
  if (state.execution === undefined) {
    state.bufferedProcessEvents.push(event);
    return;
  }
  if (event.execution === state.execution) {
    finishProcessEnd(state, event.exitCode);
  }
}

function handleTaskEnd(state: ShellTaskWaitState, event: vscode.TaskEndEvent): void {
  if (state.execution === undefined) {
    state.bufferedTaskEvents.push(event);
    return;
  }
  if (event.execution === state.execution) {
    finishProcessEnd(state, undefined);
  }
}

function finishProcessEnd(state: ShellTaskWaitState, exitCode: number | undefined): void {
  settleShellTask(state, { kind: 'ended', exitCode });
}

function cancelShellTask(state: ShellTaskWaitState): void {
  state.cancelled = true;
  const execution = state.execution;
  settleShellTask(state, { kind: 'cancelled' });
  execution?.terminate();
}

function settleShellTask(state: ShellTaskWaitState, outcome: ShellTaskOutcome): void {
  if (state.settled) {
    return;
  }
  state.settled = true;
  disposeShellTaskListeners(state);
  state.resolve(outcome);
}

function rejectShellTask(state: ShellTaskWaitState, error: unknown): void {
  if (state.settled) {
    return;
  }
  state.settled = true;
  disposeShellTaskListeners(state);
  state.reject(error);
}

function disposeShellTaskListeners(state: ShellTaskWaitState): void {
  state.listeners.forEach(listener => listener.dispose());
}

export function formatShellTaskCommandForLog(shellCommand: ShellTaskCommand): string {
  return [shellCommand.command, ...shellCommand.args]
    .map(part => typeof part === 'string' ? part : part.value)
    .join(' ');
}

export function formatShellTaskFailureMessage(taskName: string, exitCode: number | undefined): string {
  if (exitCode === undefined) {
    return vscode.l10n.t('task "{0}" ended without an exit code.', taskName);
  }

  return vscode.l10n.t('task "{0}" failed with exit code {1}.', taskName, exitCode);
}