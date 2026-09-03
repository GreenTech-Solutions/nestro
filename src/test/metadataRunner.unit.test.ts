import { EventEmitter } from 'node:events';
import * as https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  METADATA_REQUEST_TIMEOUT_MS,
  METADATA_RESPONSE_MAX_BYTES,
  runBoundedMetadataRequest,
} from '../utils';
import type { MetadataSchemaResult } from '../utils';

vi.mock('node:https', () => ({
  get: vi.fn(),
}));

interface MockClientRequest extends EventEmitter {
  destroy: ReturnType<typeof vi.fn>;
  setTimeout: ReturnType<typeof vi.fn>;
}

describe('runBoundedMetadataRequest()', () => {
  it('returns aborted without creating a request when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(runBoundedMetadataRequest('https://registry.example.test/pkg', {
      signal: controller.signal,
      parse: (): MetadataSchemaResult<string> => ({ kind: 'recognized', result: 'unused' }),
    })).resolves.toEqual({ kind: 'aborted' });
    expect(https.get).not.toHaveBeenCalled();
  });

  it('returns a recognized result after parsing a complete response', async () => {
    mockResponse(JSON.stringify({ value: 'metadata' }));

    const outcome = await runBoundedMetadataRequest('https://registry.example.test/pkg', {
      parse: (payload: unknown): MetadataSchemaResult<string> => {
        if (isRecord(payload) && payload.value === 'metadata') {
          return { kind: 'recognized', result: payload.value };
        }
        return { kind: 'unrecognized' };
      },
    });

    expect(outcome).toEqual({ kind: 'success', result: 'metadata' });
  });

  it('distinguishes unknown schemas from malformed schemas and JSON', async () => {
    mockResponse('{}');
    await expect(runBoundedMetadataRequest('https://registry.example.test/pkg', {
      parse: (): MetadataSchemaResult<string> => ({ kind: 'unrecognized' }),
    })).resolves.toEqual({ kind: 'unrecognized' });

    mockResponse('{}');
    await expect(runBoundedMetadataRequest('https://registry.example.test/pkg', {
      parse: (): MetadataSchemaResult<string> => ({ kind: 'malformed' }),
    })).resolves.toEqual({ kind: 'malformed', reason: 'schema' });

    mockResponse('{');
    await expect(runBoundedMetadataRequest('https://registry.example.test/pkg', {
      parse: (): MetadataSchemaResult<string> => ({ kind: 'recognized', result: 'unused' }),
    })).resolves.toEqual({ kind: 'malformed', reason: 'json' });
  });

  it('classifies a response that ends before its declared length as truncated', async () => {
    mockResponse('short', 200, '10');

    await expect(runBoundedMetadataRequest('https://registry.example.test/pkg', {
      parse: (): MetadataSchemaResult<string> => ({ kind: 'recognized', result: 'unused' }),
    })).resolves.toEqual({ kind: 'truncated' });
  });

  it('ignores a malformed Content-Length header', async () => {
    mockResponse('{}', 200, 'not-a-number');

    await expect(runBoundedMetadataRequest('https://registry.example.test/pkg', {
      parse: (): MetadataSchemaResult<string> => ({ kind: 'recognized', result: 'metadata' }),
    })).resolves.toEqual({ kind: 'success', result: 'metadata' });
  });

  it('classifies timeout and cancellation without trusting late completion', async () => {
    const timeoutRequest = createMockRequest();
    vi.mocked(https.get).mockImplementationOnce(() => {
      process.nextTick(() => timeoutRequest.emit('timeout'));
      return toClientRequest(timeoutRequest);
    });

    await expect(runBoundedMetadataRequest('https://registry.example.test/pkg', {
      timeoutMs: 42,
      parse: (): MetadataSchemaResult<string> => ({ kind: 'recognized', result: 'unused' }),
    })).resolves.toEqual({ kind: 'timeout', timeoutMs: 42 });
    expect(timeoutRequest.destroy).toHaveBeenCalledWith(expect.any(Error));

    const controller = new AbortController();
    let lateResponse: IncomingMessage | undefined;
    const request = createMockRequest();
    vi.mocked(https.get).mockImplementationOnce((_url, _options, callback) => {
      lateResponse = createMockResponse(200);
      process.nextTick(() => callback?.(lateResponse as IncomingMessage));
      return toClientRequest(request);
    });

    const promise = runBoundedMetadataRequest('https://registry.example.test/pkg', {
      signal: controller.signal,
      parse: (): MetadataSchemaResult<string> => ({ kind: 'recognized', result: 'late' }),
    });
    await new Promise<void>(resolve => process.nextTick(resolve));
    controller.abort();
    lateResponse?.emit('data', '{}');
    lateResponse?.emit('end');

    await expect(promise).resolves.toEqual({ kind: 'aborted' });
    expect(request.destroy).toHaveBeenCalledWith();
  });

  it('classifies oversized output before buffering it as a result', async () => {
    const request = createMockRequest();
    vi.mocked(https.get).mockImplementationOnce((_url, _options, callback) => {
      const response = createMockResponse(200);
      process.nextTick(() => {
        callback?.(response);
        response.emit('data', Buffer.alloc(METADATA_RESPONSE_MAX_BYTES + 1));
      });
      return toClientRequest(request);
    });

    await expect(runBoundedMetadataRequest('https://registry.example.test/pkg', {
      parse: (): MetadataSchemaResult<string> => ({ kind: 'recognized', result: 'unused' }),
    })).resolves.toEqual({ kind: 'overflow', maxBufferBytes: METADATA_RESPONSE_MAX_BYTES });
  });

  it('classifies response errors, aborted streams, parser exceptions, and synchronous request failures', async () => {
    const responseError = new Error('response reset');
    vi.mocked(https.get).mockImplementationOnce((_url, _options, callback) => {
      const response = createMockResponse(200);
      process.nextTick(() => {
        callback?.(response);
        response.emit('error', responseError);
      });
      return toClientRequest(createMockRequest());
    });
    await expect(runBoundedMetadataRequest('https://registry.example.test/pkg', {
      parse: (): MetadataSchemaResult<string> => ({ kind: 'recognized', result: 'unused' }),
    })).resolves.toEqual({ kind: 'transport-error', reason: 'response' });

    vi.mocked(https.get).mockImplementationOnce((_url, _options, callback) => {
      const response = createMockResponse(200);
      process.nextTick(() => {
        callback?.(response);
        response.emit('aborted');
      });
      return toClientRequest(createMockRequest());
    });
    await expect(runBoundedMetadataRequest('https://registry.example.test/pkg', {
      parse: (): MetadataSchemaResult<string> => ({ kind: 'recognized', result: 'unused' }),
    })).resolves.toEqual({ kind: 'truncated' });

    mockResponse('{}');
    await expect(runBoundedMetadataRequest('https://registry.example.test/pkg', {
      parse: (): MetadataSchemaResult<string> => {
        throw new Error('parser failure');
      },
    })).resolves.toEqual({ kind: 'malformed', reason: 'schema' });

    vi.mocked(https.get).mockImplementationOnce(() => {
      throw new Error('request setup failed');
    });
    await expect(runBoundedMetadataRequest('https://registry.example.test/pkg', {
      parse: (): MetadataSchemaResult<string> => ({ kind: 'recognized', result: 'unused' }),
    })).resolves.toEqual({ kind: 'transport-error', reason: 'request' });

    const nonErrorRequest = createMockRequest();
    vi.mocked(https.get).mockImplementationOnce(() => {
      process.nextTick(() => nonErrorRequest.emit('error', 'request failed'));
      return toClientRequest(nonErrorRequest);
    });
    await expect(runBoundedMetadataRequest('https://registry.example.test/pkg', {
      parse: (): MetadataSchemaResult<string> => ({ kind: 'recognized', result: 'unused' }),
    })).resolves.toEqual({ kind: 'transport-error', reason: 'request' });
  });

  it('uses the established network bounds by default', async () => {
    const request = createMockRequest();
    vi.mocked(https.get).mockImplementationOnce(() => {
      process.nextTick(() => request.emit('timeout'));
      return toClientRequest(request);
    });

    await runBoundedMetadataRequest('https://registry.example.test/pkg', {
      parse: (): MetadataSchemaResult<string> => ({ kind: 'recognized', result: 'unused' }),
    });

    expect(request.setTimeout).toHaveBeenCalledWith(METADATA_REQUEST_TIMEOUT_MS);
  });
});

function mockResponse(body: string, statusCode = 200, contentLength?: string): void {
  vi.mocked(https.get).mockImplementationOnce((_url, _options, callback) => {
    const response = createMockResponse(statusCode, contentLength);
    process.nextTick(() => {
      callback?.(response);
      response.emit('data', body);
      response.emit('end');
    });
    return toClientRequest(createMockRequest());
  });
}

function createMockRequest(): MockClientRequest {
  const request = new EventEmitter() as MockClientRequest;
  request.destroy = vi.fn();
  request.setTimeout = vi.fn();
  return request;
}

function createMockResponse(statusCode: number, contentLength?: string): IncomingMessage {
  const response = new EventEmitter() as IncomingMessage;
  response.statusCode = statusCode;
  response.headers = contentLength === undefined ? {} : { 'content-length': contentLength };
  response.destroy = vi.fn();
  return response;
}

function toClientRequest(request: MockClientRequest): ClientRequest {
  return request as unknown as ClientRequest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}