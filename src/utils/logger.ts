import * as vscode from 'vscode';

class Logger implements vscode.Disposable {
  private readonly outputChannel = vscode.window.createOutputChannel('Nestro');

  info(message: string): void {
    this.outputChannel.appendLine(`[info] ${message}`);
  }

  error(message: string, err?: unknown): void {
    this.outputChannel.appendLine(`[error] ${message}`);
    if (err !== undefined) {
      this.outputChannel.appendLine(formatError(err));
    }
  }

  dispose(): void {
    this.outputChannel.dispose();
  }
}

export const logger = new Logger();

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  return String(err);
}