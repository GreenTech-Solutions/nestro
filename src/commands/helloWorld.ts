import * as vscode from 'vscode';

export function helloWorldCommand(): void {
  vscode.window.showInformationMessage('Hello World from Nestro again!');
}