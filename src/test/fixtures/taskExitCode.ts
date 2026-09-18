import * as assert from 'assert';

/**
 * Asserts a shell task's exit code. Windows runs shell tasks through PowerShell `-Command`,
 * which collapses every non-zero native exit code into 1, so a non-zero expectation only
 * checks for non-zero there.
 */
export function assertTaskExitCode(actual: number | undefined, expected: number, message?: string): void {
  if (process.platform === 'win32' && expected !== 0) {
    assert.strictEqual(typeof actual, 'number', message);
    assert.notStrictEqual(actual, 0, message);
    return;
  }
  assert.strictEqual(actual, expected, message);
}