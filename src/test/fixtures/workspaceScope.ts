import * as vscode from 'vscode';
import { materializeFixture, removeMaterializedFixture } from './materialize';
import type { MaterializedFixture } from './materialize';
import type { WorkspaceFixture } from './types';

const FOLDER_EVENT_TIMEOUT_MS = 15000;

export interface OpenedFixtureWorkspace extends MaterializedFixture {
  /** Workspace folders registered for this fixture, in declaration order. */
  readonly folders: readonly vscode.WorkspaceFolder[];
}

/**
 * Materializes a fixture and appends its roots to the running Extension Host
 * workspace.
 *
 * Fixture roots are always appended after the anchor folder created by
 * `.vscode-test.mjs`, never inserted at index 0: replacing the first workspace
 * folder restarts the Extension Host, which restarts the whole test file and
 * leaves two hosts racing over the same workspace.
 */
export async function openFixtureWorkspace(fixture: WorkspaceFixture): Promise<OpenedFixtureWorkspace> {
  const materialized = await materializeFixture(fixture);
  const uris = materialized.folderPaths.map(folderPath => vscode.Uri.file(folderPath));

  // From here on the temporary copy exists on disk, and the caller has no handle
  // it could clean up until this function returns. Every failure path has to
  // undo both the folder registration and the copy itself.
  try {
    await applyWorkspaceFolderChange(() => vscode.workspace.updateWorkspaceFolders(
      countWorkspaceFolders(),
      0,
      ...uris.map(uri => ({ uri })),
    ));

    return { ...materialized, folders: uris.map(resolveRegisteredFolder) };
  }
  catch (err) {
    await discardFailedOpen(materialized, uris);
    throw err;
  }
}

/**
 * Rolls back a partially opened fixture. The workspace mutation may have been
 * rejected outright, may have timed out after taking effect, or may have landed
 * while a later step failed, so the registered folders are counted rather than
 * assumed.
 */
async function discardFailedOpen(
  materialized: MaterializedFixture,
  uris: readonly vscode.Uri[],
): Promise<void> {
  const registered = uris.filter(
    uri => vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath === uri.fsPath,
  );

  if (registered.length > 0) {
    try {
      await applyWorkspaceFolderChange(() => vscode.workspace.updateWorkspaceFolders(
        countWorkspaceFolders() - registered.length,
        registered.length,
      ));
    }
    catch {
      // Best effort only — the temporary copy still has to be removed below.
    }
  }

  await removeMaterializedFixture(materialized);
}

/**
 * Removes the fixture folders from the workspace and deletes the temporary copy,
 * restoring the baseline the test started from.
 */
export async function closeFixtureWorkspace(opened: OpenedFixtureWorkspace): Promise<void> {
  const removeCount = opened.folders.length;
  if (removeCount > 0) {
    await applyWorkspaceFolderChange(() => vscode.workspace.updateWorkspaceFolders(
      countWorkspaceFolders() - removeCount,
      removeCount,
    ));
  }
  await removeMaterializedFixture(opened);
}

export function countWorkspaceFolders(): number {
  return vscode.workspace.workspaceFolders?.length ?? 0;
}

function resolveRegisteredFolder(uri: vscode.Uri): vscode.WorkspaceFolder {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (folder === undefined) {
    throw new Error(`No workspace folder was registered for ${uri.fsPath}.`);
  }
  return folder;
}

async function applyWorkspaceFolderChange(mutate: () => boolean): Promise<void> {
  const pending = waitForWorkspaceFoldersChange();
  let accepted: boolean;
  try {
    accepted = mutate();
  }
  catch (err) {
    pending.cancel();
    throw err;
  }

  if (!accepted) {
    pending.cancel();
    throw new Error('vscode.workspace.updateWorkspaceFolders() rejected the requested change.');
  }
  await pending.completed;
}

interface PendingFolderChange {
  readonly completed: Promise<void>;
  readonly cancel: () => void;
}

function waitForWorkspaceFoldersChange(): PendingFolderChange {
  let subscription: vscode.Disposable | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancel = (): void => {
    subscription?.dispose();
    subscription = undefined;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const completed = new Promise<void>((resolve, reject) => {
    subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      cancel();
      resolve();
    });
    timer = setTimeout(() => {
      cancel();
      reject(new Error(`onDidChangeWorkspaceFolders did not fire within ${FOLDER_EVENT_TIMEOUT_MS}ms.`));
    }, FOLDER_EVENT_TIMEOUT_MS);
  });

  return { completed, cancel };
}