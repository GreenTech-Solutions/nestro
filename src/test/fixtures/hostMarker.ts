import * as vscode from 'vscode';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MARKER_FILE_NAME = 'extension-host-pids.log';

/**
 * Records the current Extension Host process next to the generated
 * `.code-workspace` file.
 *
 * A restart cannot be detected from inside the process it kills. `process.pid`
 * is constant for the lifetime of a process, and a restart re-loads this module
 * from scratch in the new host, so any in-memory copy of the pid is
 * re-initialized along with it — comparing the two can never fail. The evidence
 * therefore has to outlive the process, which is why it goes to disk.
 *
 * `.vscode-test.mjs` removes the channel workspace directory before every run,
 * so the file always starts empty and one recorded line means one host.
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