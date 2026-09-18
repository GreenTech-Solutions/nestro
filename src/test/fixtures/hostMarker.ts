import * as vscode from 'vscode';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MARKER_FILE_NAME = 'extension-host-pids.log';

/**
 * Records the current Extension Host pid to disk, since a restart cannot be detected from
 * inside the process it kills — any in-memory copy of the pid is re-initialized with it.
 * `.vscode-test.mjs` clears this file before every run, so one line means one host.
 */
export function recordExtensionHost(): void {
  appendFileSync(markerFilePath(), `${process.pid}\n`, 'utf8');
}

/** Process ids of every Extension Host that loaded the suite during this run. */
export function recordedExtensionHosts(): number[] {
  return readFileSync(markerFilePath(), 'utf8')
    .split('\n')
    .filter(line => line.length > 0)
    .map(Number);
}

function markerFilePath(): string {
  const workspaceFile = vscode.workspace.workspaceFile;
  if (workspaceFile === undefined || workspaceFile.scheme !== 'file') {
    throw new Error(
      'The suite must run in the generated .code-workspace file created by .vscode-test.mjs. '
      + 'Without it the anchor folder is missing and adding a fixture would replace workspace '
      + 'folder 0, which restarts the Extension Host.',
    );
  }
  return join(dirname(workspaceFile.fsPath), MARKER_FILE_NAME);
}