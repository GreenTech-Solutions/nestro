import { runCliAsEntry } from './cliBootstrap';
import { runVerifyVsixCli } from './verifyVsixRunner';
import type { VerifyVsixCliDependencies } from './verifyVsixRunner';
import { createNodeVsixVerifierIo } from './verifyVsixNodeIo';

/** The part of a writable stream this CLI needs; keeps the writer testable. */
export interface LineWritableStream {
  write(chunk: string): boolean;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

function isBrokenPipe(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EPIPE';
}

/**
 * Wraps a stream in a line writer that tolerates the consumer hanging up: a piped consumer
 * (e.g. `grep -Fxq`) that exits early closes the pipe mid-write, and Node's EPIPE error would
 * otherwise crash the process. EPIPE is swallowed; every other write error still surfaces.
 */
export function createStreamLineWriter(stream: LineWritableStream): (line: string) => void {
  stream.on('error', (error: Error) => {
    if (!isBrokenPipe(error)) {
      throw error;
    }
  });
  return (line: string): void => {
    try {
      stream.write(`${line}\n`);
    }
    catch (error) {
      if (!isBrokenPipe(error)) {
        throw error;
      }
    }
  };
}

export function createNodeCliDependencies(cwd: string): VerifyVsixCliDependencies {
  return {
    io: createNodeVsixVerifierIo(cwd),
    writeOut: createStreamLineWriter(process.stdout),
    writeError: createStreamLineWriter(process.stderr),
  };
}

export function main(argv: readonly string[], cwd: string): Promise<number> {
  return runVerifyVsixCli(argv, createNodeCliDependencies(cwd));
}

/* v8 ignore start -- process bootstrap: only reachable when node runs this file directly */
runCliAsEntry(typeof module === 'undefined' ? undefined : module, () => main(process.argv.slice(2), process.cwd()));
/* v8 ignore stop */