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
 * Materializes a fixture and appends its roots to the running Extension Host workspace,
 * always after the anchor folder created by `.vscode-test.mjs`, never at index 0: replacing
 * the first workspace folder restarts the Extension Host mid test file.
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
 * The workspace mutation may have been rejected outright, timed out after taking effect, or
 * landed while a later step failed, so the registered folders are counted here rather than
 * assumed.
 */
async function discardFailedOpen(
  materialized: MaterializedFixture,
  uris: readonly vscode.Uri[],
): Promise<void> {
  for (const uri of uris) {
    const registered = vscode.workspace.getWorkspaceFolder(uri);
    if (registered?.uri.fsPath !== uri.fsPath) {
      continue;
    }
    try {
      await applyWorkspaceFolderChange(() => vscode.workspace.updateWorkspaceFolders(registered.index, 1));
    }
    catch {
      // Best effort only — the temporary copy still has to be removed below.
    }
  }

  await removeMaterializedFixture(materialized);
}

/**
 * Removes the fixture folders from the workspace and deletes the temporary copy. Folders are
 * removed by identity rather than by tail position: a stale folder count would shift the start
 * index and take the anchor folder with it.
 */
export async function closeFixtureWorkspace(opened: OpenedFixtureWorkspace): Promise<void> {
  for (const folder of opened.folders) {
    const current = vscode.workspace.getWorkspaceFolder(folder.uri);
    if (current?.uri.fsPath !== folder.uri.fsPath) {
      continue;
    }
    await applyWorkspaceFolderChange(() => vscode.workspace.updateWorkspaceFolders(current.index, 1));
  }
  await removeMaterializedFixture(opened);
}

export function countWorkspaceFolders(): number {
  return vscode.workspace.workspaceFolders?.length ?? 0;
}

/** Every fixture root opened during the run, checked for leaks at the end. */
const openedRoots: string[] = [];

/** Opens a fixture and records its root so the lifecycle suite can audit it. */
export async function openTrackedFixture(fixture: WorkspaceFixture): Promise<OpenedFixtureWorkspace> {
  const opened = await openFixtureWorkspace(fixture);
  openedRoots.push(opened.rootPath);
  return opened;
}

export function trackedFixtureRoots(): readonly string[] {
  return openedRoots;
}

/**
 * Closes a fixture opened in `suiteSetup`. A failed setup leaves the handle
 * undefined, and an unguarded teardown would hide the original failure.
 */
export async function closeIfOpen(opened: OpenedFixtureWorkspace | undefined): Promise<void> {
  if (opened !== undefined) {
    await closeFixtureWorkspace(opened);
  }
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