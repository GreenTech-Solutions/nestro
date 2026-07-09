import * as vscode from 'vscode';

export interface ShellTaskCommand {
  command: string | vscode.ShellQuotedString;
  args: (string | vscode.ShellQuotedString)[];
}

export async function runShellTaskAndWait(
  shellCommand: ShellTaskCommand,
  taskName: string,
  cwd?: string,
): Promise<number | undefined> {
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

export function formatShellTaskCommandForLog(shellCommand: ShellTaskCommand): string {
  return [shellCommand.command, ...shellCommand.args]
    .map(part => typeof part === 'string' ? part : part.value)
    .join(' ');
}

export function formatShellTaskFailureMessage(taskName: string, exitCode: number | undefined): string {
  if (exitCode === undefined) {
    return `task "${taskName}" ended without an exit code.`;
  }

  return `task "${taskName}" failed with exit code ${exitCode}.`;
}