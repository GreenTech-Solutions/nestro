import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ShellTaskCommand } from '../../utils';
import { removeFixturePath } from './removeFixturePath';

const TEMP_DIR_PREFIX = 'nestro-task-script-';

const EXIT_WITH_CODE_SCRIPT = 'process.exit(Number(process.argv[2]));\n';

/**
 * Bounded so a run that never gets terminated still exits on its own instead
 * of leaving an orphaned Node process behind; every test that starts this
 * script terminates it well before the bound is reached.
 */
const SLEEP_SCRIPT = 'setTimeout(() => process.exit(0), 30000);\n';

export interface ScriptFixture {
  readonly dir: string;
  readonly exitWithCodePath: string;
  readonly sleepPath: string;
}

/**
 * Writes the Node scripts the task-lifecycle integration tests run as real
 * shell tasks. Node is already a runtime dependency of the test environment,
 * so these run cross-platform without invoking a package manager or reaching
 * a registry.
 */
export async function createScriptFixture(): Promise<ScriptFixture> {
  const dir = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
  const exitWithCodePath = join(dir, 'exit-with-code.js');
  const sleepPath = join(dir, 'sleep.js');
  await writeFile(exitWithCodePath, EXIT_WITH_CODE_SCRIPT, 'utf8');
  await writeFile(sleepPath, SLEEP_SCRIPT, 'utf8');
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