import * as assert from 'assert';

/**
 * Asserts a shell task's exit code. Windows runs shell tasks through PowerShell `-Command`,
 * which collapses every non-zero native exit code into 1, so a non-zero expectation only
 * checks for non-zero there.
 */
export function assertTaskExitCode(
  actual: import('../../utils/shellTask').ShellTaskOutcome,
  expected: number,
  message?: string,
): void {
  assert.ok(
    actual.kind === 'ended' && actual.exitCode !== undefined,
    message ?? 'Task should report a numeric process exit code',
  );
  if (actual.kind !== 'ended' || actual.exitCode === undefined) {
    return;
  }
  if (process.platform === 'win32' && expected !== 0) {
    assert.notStrictEqual(actual.exitCode, 0, message);
    return;
  }
  assert.strictEqual(actual.exitCode, expected, message);
}