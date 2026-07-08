import * as vscode from 'vscode';

export async function runShellTaskAndWait(
  command: string,
  taskName: string,
  cwd?: string,
): Promise<number | undefined> {
  const task = new vscode.Task(
    { type: 'shell' },
    vscode.TaskScope.Workspace,
    taskName,
    'Nestro',
    new vscode.ShellExecution(command, cwd === undefined ? undefined : { cwd }),
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