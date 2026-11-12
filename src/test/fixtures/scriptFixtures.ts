import { copyFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { ShellTaskCommand } from '../../utils';
import { removeFixturePath } from './removeFixturePath';

const TEMP_DIR_PREFIX = 'nestro-task-script-';
const SCRIPT_DIRECTORY = resolve(__dirname, '../../../src/test/fixtures/scripts');

export interface ScriptFixture {
  readonly dir: string;
  readonly exitWithCodePath: string;
  readonly sleepPath: string;
}

/** Copies the Node scripts used by task-lifecycle tests into a unique temporary directory. */
export async function createScriptFixture(): Promise<ScriptFixture> {
  const dir = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
  const exitWithCodePath = join(dir, 'exit-with-code.js');
  const sleepPath = join(dir, 'sleep.js');
  await Promise.all([
    copyFile(join(SCRIPT_DIRECTORY, 'exit-with-code.js'), exitWithCodePath),
    copyFile(join(SCRIPT_DIRECTORY, 'sleep.js'), sleepPath),
  ]);
  return { dir, exitWithCodePath, sleepPath };
}

/** Deletes the temporary directory created by {@link createScriptFixture}. */
export async function removeScriptFixture(fixture: ScriptFixture): Promise<void> {
  await removeFixturePath(fixture.dir);
}

/** A shell task command that exits with a controlled, caller-chosen code. */
export function buildExitWithCodeCommand(fixture: ScriptFixture, exitCode: number): ShellTaskCommand {
  return {
    command: 'node',
    args: [
      { value: fixture.exitWithCodePath, quoting: vscode.ShellQuoting.Strong },
      String(exitCode),
    ],
  };
}

/** A shell task command that keeps running until terminated. */
export function buildSleepCommand(fixture: ScriptFixture): ShellTaskCommand {
  return {
    command: 'node',
    args: [{ value: fixture.sleepPath, quoting: vscode.ShellQuoting.Strong }],
  };
}