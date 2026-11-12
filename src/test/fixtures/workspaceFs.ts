import * as vscode from 'vscode';
import { vi } from 'vitest';

export function mockWorkspaceFiles(files: Readonly<Record<string, string>>): void {
  vi.mocked(vscode.workspace.fs.readFile).mockImplementation((uri: vscode.Uri) => {
    const contents = files[uri.fsPath];
    if (contents === undefined) {
      return Promise.reject(new Error(`File not found: ${uri.fsPath}`));
    }
    return Promise.resolve(Buffer.from(contents));
  });
  vi.mocked(vscode.workspace.fs.stat).mockImplementation((uri: vscode.Uri) => {
    const contents = files[uri.fsPath];
    if (contents === undefined) {
      return Promise.reject(new Error(`File not found: ${uri.fsPath}`));
    }
    return Promise.resolve({
      type: vscode.FileType.File,
      ctime: 0,
      mtime: 0,
      size: Buffer.byteLength(contents),
    });
  });
}