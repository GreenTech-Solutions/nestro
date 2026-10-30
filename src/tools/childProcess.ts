import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const MAX_CHILD_OUTPUT_BYTES = 64 * 1024 * 1024;

const execFileAsync = promisify(execFile);

function describeChildFailure(command: string, error: unknown): Error {
  const details = error as { stdout?: string; stderr?: string; message?: string };
  const output = [details.stdout, details.stderr].filter(part => !!part).join('\n').trim();
  const reason = details.message ?? String(error);
  return new Error(output.length > 0 ? `${command} failed: ${reason}\n${output}` : `${command} failed: ${reason}`);
}

/** Runs `command` in `cwd` and returns stdout; a failure carries `label` and the child's output. */
export async function runChildProcess(command: string, args: readonly string[], cwd: string, label: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, [...args], { cwd, maxBuffer: MAX_CHILD_OUTPUT_BYTES });
    return stdout;
  }
  catch (error) {
    throw describeChildFailure(label, error);
  }
}