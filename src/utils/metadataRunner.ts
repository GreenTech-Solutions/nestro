import * as https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';

export const METADATA_REQUEST_TIMEOUT_MS = 15_000;
export const METADATA_RESPONSE_MAX_BYTES = 5 * 1024 * 1024;

/** A response schema was recognized and converted into typed metadata. */
export interface MetadataSchemaRecognized<T> {
  kind: 'recognized';
  result: T;
}

/** A valid response does not match any schema known to the selected adapter. */
export interface MetadataSchemaUnrecognized {
  kind: 'unrecognized';
}

/** A response matched the expected schema boundary but contained invalid fields. */
export interface MetadataSchemaMalformed {
  kind: 'malformed';
}

export type MetadataSchemaResult<T>
  = | MetadataSchemaRecognized<T>
    | MetadataSchemaUnrecognized
    | MetadataSchemaMalformed;

/** The adapter returned complete, schema-recognized metadata. */
export interface MetadataSuccess<T> {
  kind: 'success';
  result: T;
}

/** Configuration could not be resolved; missing executables are transport failures. */
export interface MetadataUnavailable {
  kind: 'unavailable';
  reason: 'configuration-unavailable';
}

/** The response is valid but does not match a known metadata schema. */
export interface MetadataUnrecognized {
  kind: 'unrecognized';
}

/** JSON or a recognized schema is malformed; callers may try another adapter. */
export interface MetadataMalformed {
  kind: 'malformed';
  reason: 'json' | 'schema';
}

/** The response ended before its declared length or its stream was aborted. */
export interface MetadataTruncated {
  kind: 'truncated';
}

/** The response exceeded the bounded request buffer. */
export interface MetadataOverflow {
  kind: 'overflow';
  maxBufferBytes: number;
}

/** The request exceeded its deadline and was terminated. */
export interface MetadataTimeout {
  kind: 'timeout';
  timeoutMs: number;
}

/** The caller cancelled the request; no adapter result is usable. */
export interface MetadataAborted {
  kind: 'aborted';
}

/** Network or adapter execution failed; selection outcomes are produced only by the registry. */
export interface MetadataTransportError {
  kind: 'transport-error';
  reason: 'request' | 'response' | 'http-status' | 'selection' | 'command-not-found' | 'process-failed' | 'proxy-unsupported';
  statusCode?: number;
}

export interface BoundedMetadataTransportError extends MetadataTransportError {
  message?: string;
  redirectLocation?: string;
}

export type MetadataOutcome<T>
  = | MetadataSuccess<T>
    | MetadataUnavailable
    | MetadataUnrecognized
    | MetadataMalformed
    | MetadataTruncated
    | MetadataOverflow
    | MetadataTimeout
    | MetadataAborted
    | MetadataTransportError;

export type BoundedMetadataOutcome<T>
  = | Exclude<MetadataOutcome<T>, MetadataTransportError>
    | BoundedMetadataTransportError;

export interface BoundedMetadataRequestOptions<T> {
  parse: (payload: unknown) => MetadataSchemaResult<T>;
  headers?: Readonly<Record<string, string>>;
  ca?: string;
  rejectUnauthorized?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBufferBytes?: number;
  timeoutErrorMessage?: string;
  overflowErrorMessage?: string;
}

export function runBoundedMetadataRequest<T>(
  url: string,
  options: BoundedMetadataRequestOptions<T>,
): Promise<BoundedMetadataOutcome<T>> {
  const timeoutMs = options.timeoutMs ?? METADATA_REQUEST_TIMEOUT_MS;
  const maxBufferBytes = options.maxBufferBytes ?? METADATA_RESPONSE_MAX_BYTES;

  if (options.signal?.aborted === true) {
    return Promise.resolve({ kind: 'aborted' });
  }

  return new Promise<BoundedMetadataOutcome<T>>((resolve) => {
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let receivedBytes = 0;
    const chunks: Buffer[] = [];

    const settle = (outcome: BoundedMetadataOutcome<T>): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutTimer);
      options.signal?.removeEventListener('abort', onAbort);
      request?.removeListener('timeout', onTimeout);
      response?.removeListener('data', onData);
      response?.removeListener('end', onEnd);
      response?.removeListener('aborted', onResponseAborted);
      resolve(outcome);
    };
    const destroyRequest = (error?: Error): void => {
      if (error === undefined) {
        request?.destroy();
      }
      else {
        request?.destroy(error);
      }
      response?.destroy?.();
    };
    const onAbort = (): void => {
      settle({ kind: 'aborted' });
      destroyRequest();
    };
    const onTimeout = (): void => {
      settle({ kind: 'timeout', timeoutMs });
      destroyRequest(new Error(options.timeoutErrorMessage ?? `metadata request timed out after ${timeoutMs}ms`));
    };
    const onData = (chunk: Buffer | string): void => {
      if (settled) {
        return;
      }

      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += buffer.length;
      if (receivedBytes > maxBufferBytes) {
        settle({ kind: 'overflow', maxBufferBytes });
        destroyRequest(new Error(options.overflowErrorMessage ?? `metadata response exceeded ${maxBufferBytes} bytes`));
        return;
      }

      chunks.push(buffer);
    };
    const onResponseAborted = (): void => {
      settle({ kind: 'truncated' });
    };
    const onResponseError = (error: unknown): void => {
      settle(createTransportError('response', error));
    };
    const onRequestError = (error: unknown): void => {
      settle(createTransportError('request', error));
    };
    const onEnd = (): void => {
      if (settled) {
        return;
      }

      const expectedBytes = getContentLength(response);
      if (expectedBytes !== undefined && expectedBytes !== receivedBytes) {
        settle({ kind: 'truncated' });
        return;
      }

      if (response?.statusCode !== undefined && (response.statusCode < 200 || response.statusCode >= 300)) {
        const location = response.headers?.location;
        settle({
          kind: 'transport-error',
          reason: 'http-status',
          statusCode: response.statusCode,
          ...(response.statusCode >= 300 && response.statusCode < 400 && typeof location === 'string'
            ? { redirectLocation: location }
            : {}),
        });
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      }
      catch {
        settle({ kind: 'malformed', reason: 'json' });
        return;
      }

      try {
        const parsed = options.parse(payload);
        switch (parsed.kind) {
          case 'recognized':
            settle({ kind: 'success', result: parsed.result });
            return;
          case 'unrecognized':
            settle({ kind: 'unrecognized' });
            return;
          case 'malformed':
            settle({ kind: 'malformed', reason: 'schema' });
            return;
        }
      }
      catch {
        settle({ kind: 'malformed', reason: 'schema' });
      }
    };

    options.signal?.addEventListener('abort', onAbort, { once: true });
    timeoutTimer = setTimeout(onTimeout, timeoutMs);

    try {
      request = https.get(url, {
        headers: options.headers,
        ...(options.ca === undefined ? {} : { ca: options.ca }),
        ...(options.rejectUnauthorized === undefined ? {} : { rejectUnauthorized: options.rejectUnauthorized }),
      }, (incomingResponse) => {
        response = incomingResponse;
        incomingResponse.on('data', onData);
        incomingResponse.on('end', onEnd);
        incomingResponse.on('aborted', onResponseAborted);
        incomingResponse.on('error', onResponseError);
      });
      request.setTimeout(timeoutMs);
      request.on('timeout', onTimeout);
      request.on('error', onRequestError);
    }
    catch (error) {
      settle(createTransportError('request', error));
    }
  });
}

function getContentLength(response: IncomingMessage | undefined): number | undefined {
  const value = response?.headers?.['content-length'];
  if (typeof value !== 'string') {
    return undefined;
  }

  const contentLength = Number(value);
  return Number.isSafeInteger(contentLength) && contentLength >= 0 ? contentLength : undefined;
}

function createTransportError(
  reason: 'request' | 'response',
  _error: unknown,
): BoundedMetadataTransportError {
  return { kind: 'transport-error', reason };
}