import * as https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { METADATA_REQUEST_TIMEOUT_MS, METADATA_RESPONSE_MAX_BYTES } from '../config';
import { classifyCompletedResponse, createTransportError } from './metadataResponse';

export { mapSchemaResult } from './metadataResponse';

export interface MetadataPrivateRegistryContext {
  privateRegistry?: boolean;
}

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
export interface MetadataSuccess<T> extends MetadataPrivateRegistryContext {
  kind: 'success';
  result: T;
}

/** Configuration could not be resolved; missing executables are transport failures. */
export interface MetadataUnavailable extends MetadataPrivateRegistryContext {
  kind: 'unavailable';
  reason: 'configuration-unavailable';
  message?: string;
}

/** The response is valid but does not match a known metadata schema. */
export interface MetadataUnrecognized extends MetadataPrivateRegistryContext {
  kind: 'unrecognized';
}

/** JSON or a recognized schema is malformed; callers may try another adapter. */
export interface MetadataMalformed extends MetadataPrivateRegistryContext {
  kind: 'malformed';
  reason: 'json' | 'schema';
}

/** The response ended before its declared length or its stream was aborted. */
export interface MetadataTruncated extends MetadataPrivateRegistryContext {
  kind: 'truncated';
}

/** The response exceeded the bounded request buffer. */
export interface MetadataOverflow extends MetadataPrivateRegistryContext {
  kind: 'overflow';
  maxBufferBytes: number;
}

/** The request exceeded its deadline and was terminated. */
export interface MetadataTimeout extends MetadataPrivateRegistryContext {
  kind: 'timeout';
  timeoutMs: number;
}

/** The caller cancelled the request; no adapter result is usable. */
export interface MetadataAborted extends MetadataPrivateRegistryContext {
  kind: 'aborted';
}

/** Network or adapter execution failed; selection outcomes are produced only by the registry. */
export interface MetadataTransportError extends MetadataPrivateRegistryContext {
  kind: 'transport-error';
  reason: 'request' | 'response' | 'http-status' | 'selection' | 'command-not-found' | 'process-failed' | 'proxy-unsupported';
  statusCode?: number;
}

export interface BoundedMetadataTransportError extends MetadataTransportError {
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
  if (options.signal?.aborted === true) {
    return Promise.resolve({ kind: 'aborted' });
  }

  return new Promise<BoundedMetadataOutcome<T>>((resolve) => {
    new MetadataRequestRun(url, options, resolve).start();
  });
}

/** One in-flight request: wires the deadline, abort signal and byte cap, and resolves exactly once. */
class MetadataRequestRun<T> {
  private request: ClientRequest | undefined;
  private response: IncomingMessage | undefined;
  private settled = false;
  private timeoutTimer: NodeJS.Timeout | undefined;
  private receivedBytes = 0;
  private readonly chunks: Buffer[] = [];
  private readonly timeoutMs: number;
  private readonly maxBufferBytes: number;

  constructor(
    private readonly url: string,
    private readonly options: BoundedMetadataRequestOptions<T>,
    private readonly resolve: (outcome: BoundedMetadataOutcome<T>) => void,
  ) {
    this.timeoutMs = options.timeoutMs ?? METADATA_REQUEST_TIMEOUT_MS;
    this.maxBufferBytes = options.maxBufferBytes ?? METADATA_RESPONSE_MAX_BYTES;
  }

  start(): void {
    const { options } = this;
    options.signal?.addEventListener('abort', this.onAbort, { once: true });
    this.timeoutTimer = setTimeout(this.onTimeout, this.timeoutMs);

    try {
      this.request = https.get(this.url, {
        headers: options.headers,
        ...(options.ca === undefined ? {} : { ca: options.ca }),
        ...(options.rejectUnauthorized === undefined ? {} : { rejectUnauthorized: options.rejectUnauthorized }),
      }, this.attachResponse);
      this.request.setTimeout(this.timeoutMs);
      this.request.on('timeout', this.onTimeout);
      this.request.on('error', this.onRequestError);
    }
    catch (error) {
      this.settle(createTransportError('request', error));
    }
  }

  private readonly attachResponse = (incomingResponse: IncomingMessage): void => {
    this.response = incomingResponse;
    incomingResponse.on('data', this.onData);
    incomingResponse.on('end', this.onEnd);
    incomingResponse.on('aborted', this.onResponseAborted);
    incomingResponse.on('error', this.onResponseError);
  };

  private settle(outcome: BoundedMetadataOutcome<T>): void {
    if (this.settled) {
      return;
    }

    this.settled = true;
    clearTimeout(this.timeoutTimer);
    this.options.signal?.removeEventListener('abort', this.onAbort);
    this.request?.removeListener('timeout', this.onTimeout);
    this.response?.removeListener('data', this.onData);
    this.response?.removeListener('end', this.onEnd);
    this.response?.removeListener('aborted', this.onResponseAborted);
    this.resolve(outcome);
  }

  private destroyRequest(error?: Error): void {
    if (error === undefined) {
      this.request?.destroy();
    }
    else {
      this.request?.destroy(error);
    }
    this.response?.destroy?.();
  }

  private readonly onAbort = (): void => {
    this.settle({ kind: 'aborted' });
    this.destroyRequest();
  };

  private readonly onTimeout = (): void => {
    this.settle({ kind: 'timeout', timeoutMs: this.timeoutMs });
    this.destroyRequest(new Error(this.options.timeoutErrorMessage ?? `metadata request timed out after ${this.timeoutMs}ms`));
  };

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.settled) {
      return;
    }

    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.receivedBytes += buffer.length;
    if (this.receivedBytes > this.maxBufferBytes) {
      this.settle({ kind: 'overflow', maxBufferBytes: this.maxBufferBytes });
      this.destroyRequest(new Error(this.options.overflowErrorMessage ?? `metadata response exceeded ${this.maxBufferBytes} bytes`));
      return;
    }

    this.chunks.push(buffer);
  };

  private readonly onResponseAborted = (): void => {
    this.settle({ kind: 'truncated' });
  };

  private readonly onResponseError = (error: unknown): void => {
    this.settle(createTransportError('response', error));
  };

  private readonly onRequestError = (error: unknown): void => {
    this.settle(createTransportError('request', error));
  };

  private readonly onEnd = (): void => {
    if (this.settled) {
      return;
    }

    this.settle(classifyCompletedResponse(this.response, this.receivedBytes, Buffer.concat(this.chunks), this.options.parse));
  };
}