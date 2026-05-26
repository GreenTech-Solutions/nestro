import * as vscode from 'vscode';

export function showError(message: string): void {
    void vscode.window.showErrorMessage(`Nestro: ${message}`);
}
