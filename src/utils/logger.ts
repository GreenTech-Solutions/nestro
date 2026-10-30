import * as vscode from 'vscode';
import { redactCredentials, sanitizeMultilineText } from '../shared';

const CONTINUATION_PREFIX = '↳ ';

class Logger implements vscode.Disposable {
  private readonly outputChannel = vscode.window.createOutputChannel('Nestro', { log: true });

  info(message: string): void {
    this.outputChannel.info(sanitizeLogText(message));
  }

  warn(message: string): void {
    this.outputChannel.warn(sanitizeLogText(message));
  }

  debug(message: string): void {
    this.outputChannel.debug(sanitizeLogText(message));
  }

  error(message: string, err?: unknown): void {
    this.outputChannel.error(sanitizeLogText(message));
    if (err !== undefined) {
      this.outputChannel.error(sanitizeLogText(formatError(err)));
    }
  }

  dispose(): void {
    this.outputChannel.dispose();
  }
}

export const logger = new Logger();

export function sanitizeLogText(message: string): string {
  return redactCredentials(sanitizeMultilineText(message))
    .split('\n')
    .map((line, index) => index === 0 ? line : `${CONTINUATION_PREFIX}${line}`)
    .join('\n');
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  return String(err);
}