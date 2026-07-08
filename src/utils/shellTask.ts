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

  const execution = await vscode.tasks.executeTask(task);

  return await new Promise((resolve) => {
    let processListener: vscode.Disposable | undefined;
    let taskListener: vscode.Disposable | undefined;

    const finish = (exitCode: number | undefined): void => {
      processListener?.dispose();
      taskListener?.dispose();
      resolve(exitCode);
    };

    processListener = vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution !== execution) {
        return;
      }

      finish(event.exitCode);
    });

    taskListener = vscode.tasks.onDidEndTask((event) => {
      if (event.execution !== execution) {
        return;
      }

      finish(undefined);
    });
  });
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
