import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import * as https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { expect, vi } from 'vitest';

interface MockClientRequest extends EventEmitter {
  destroy: ReturnType<typeof vi.fn>;
  setTimeout: ReturnType<typeof vi.fn>;
}

export function mockRegistryResponse(body: string, statusCode = 200, location?: string): void {
  vi.mocked(https.get).mockImplementationOnce((_url, _options, callback) => {
    const response = new EventEmitter() as IncomingMessage;
    response.statusCode = statusCode;
    response.headers = location === undefined ? {} : { location };
    process.nextTick(() => {
      callback?.(response);
      response.emit('data', body);
      response.emit('end');
    });
    return toClientRequest(createMockRequest());
  });
}

export function mockNpmrcFiles(files: Record<string, string>): void {
  vi.mocked(readFile).mockImplementation((filePath) => {
    const value = files[String(filePath)];

    if (value === undefined) {
      return Promise.reject(new Error(`File not found: ${String(filePath)}`));
    }

    return Promise.resolve(value);
  });
}

export function expectRegistryUrl(url: string): void {
  expect(vi.mocked(https.get).mock.calls[0][0]).toBe(url);
}

export function expectRequestHeaders(expected: Record<string, string>): void {
  expect(vi.mocked(https.get).mock.calls[0][1]).toMatchObject({
    headers: expect.objectContaining(expected),
  });
}

export function createMockRequest(): MockClientRequest {
  const request = new EventEmitter() as MockClientRequest;
  request.destroy = vi.fn();
  request.setTimeout = vi.fn();
  return request;
}

export function toClientRequest(request: MockClientRequest): ClientRequest {
  return request as unknown as ClientRequest;
}