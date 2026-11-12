import * as vscode from 'vscode';

export interface WorkspaceFolderStub {
  readonly uri: Pick<vscode.Uri, 'fsPath'>;
  readonly name?: string;
  readonly index?: number;
}

export type WorkspaceFoldersStub = readonly WorkspaceFolderStub[] | undefined;

export function setWorkspaceFolders(folders: WorkspaceFoldersStub): () => void {
  const previousFolders = vscode.workspace.workspaceFolders;
  Object.defineProperty(vscode.workspace, 'workspaceFolders', {
    configurable: true,
    value: folders,
  });
  return () => {
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      configurable: true,
      value: previousFolders,
    });
  };
}