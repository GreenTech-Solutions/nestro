import { AUDIT_PROCESS_MAX_BUFFER_BYTES } from '../../config';
import type { Mock } from 'vitest';

export function mockAuditProcess(
  processMock: Mock,
  err: unknown,
  stdout: string,
  commandName: string,
): void {
  processMock.mockImplementationOnce(() => {
    if (err === null) {
      return Promise.resolve({ kind: 'exit', stdout, stderr: '', exitCode: 0 });
    }
    const properties = typeof err === 'object' && err !== null
      ? err as { code?: unknown; stdout?: unknown; stderr?: unknown }
      : {};
    const output = typeof properties.stdout === 'string' ? properties.stdout : stdout;
    const stderr = typeof properties.stderr === 'string' ? properties.stderr : '';
    if (properties.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return Promise.resolve({ kind: 'overflow', maxBufferBytes: AUDIT_PROCESS_MAX_BUFFER_BYTES });
    }
    if (typeof properties.code === 'number') {
      return Promise.resolve({ kind: 'exit', stdout: output, stderr, exitCode: properties.code });
    }
    const message = err instanceof Error ? err.message : String(err);
    return Promise.resolve({
      kind: 'spawn-error',
      reason: properties.code === 'ENOENT' ? 'command-not-found' : 'process-failed',
      detail: `${commandName} could not run: ${message}`,
      message,
      cause: err,
    });
  });
}

export function mockAuditSuccess(processMock: Mock, stdout: string, commandName: string): void {
  mockAuditProcess(processMock, null, stdout, commandName);
}

export function createAuditProcessMocks(processMock: Mock, commandName: string): {
  mockAuditProcess: (err: unknown, stdout: string) => void;
  mockAuditSuccess: (stdout: string) => void;
} {
  return {
    mockAuditProcess: (err, stdout) => mockAuditProcess(processMock, err, stdout, commandName),
    mockAuditSuccess: stdout => mockAuditSuccess(processMock, stdout, commandName),
  };
}