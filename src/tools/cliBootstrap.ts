/** Runs `run` and sets the process exit code when `entry` is the module node started; otherwise does nothing. */
export function runCliAsEntry(
  entry: NodeJS.Module | undefined,
  run: () => Promise<number>,
  startedModule: NodeJS.Module | undefined = typeof require === 'undefined' ? undefined : require.main,
): void {
  if (entry === undefined || entry !== startedModule) {
    return;
  }
  void run().then((exitCode) => {
    process.exitCode = exitCode;
  });
}