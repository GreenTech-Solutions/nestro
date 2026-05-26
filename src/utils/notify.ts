import * as vscode from 'vscode';
import { logger } from './logger';

export function showError(message: string, err?: unknown): void {
    logger.error(message, err);
    void vscode.window.showErrorMessage(`Nestro: ${message}`);
}
