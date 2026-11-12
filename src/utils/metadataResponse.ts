import type { IncomingMessage } from 'node:http';
import type {
  BoundedMetadataOutcome,
  BoundedMetadataTransportError,
  MetadataMalformed,
  MetadataSchemaResult,
  MetadataSuccess,
  MetadataUnrecognized,
} from './metadataRunner';

/** Classifies a fully received response: truncation, HTTP status, JSON syntax, then schema. */
export function classifyCompletedResponse<T>(
  response: IncomingMessage | undefined,
  receivedBytes: number,
  body: Buffer,
  parse: (payload: unknown) => MetadataSchemaResult<T>,
): BoundedMetadataOutcome<T> {
  const expectedBytes = getContentLength(response);
  if (expectedBytes !== undefined && expectedBytes !== receivedBytes) {
    return { kind: 'truncated' };
  }

  if (response?.statusCode !== undefined && (response.statusCode < 200 || response.statusCode >= 300)) {
    const location = response.headers?.location;
    return {
      kind: 'transport-error',
      reason: 'http-status',
      statusCode: response.statusCode,
      ...(response.statusCode >= 300 && response.statusCode < 400 && typeof location === 'string'
        ? { redirectLocation: location }
        : {}),
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body.toString('utf8')) as unknown;
  }
  catch {
    return { kind: 'malformed', reason: 'json' };
  }

  try {
    return mapSchemaResult(parse(payload));
  }
  catch {
    return { kind: 'malformed', reason: 'schema' };
  }
}

/** Converts a parser result into the outcome that ends a metadata request. */
export function mapSchemaResult<T>(
  parsed: MetadataSchemaResult<T>,
): MetadataSuccess<T> | MetadataUnrecognized | MetadataMalformed {
  switch (parsed.kind) {
    case 'recognized':
      return { kind: 'success', result: parsed.result };
    case 'unrecognized':
      return { kind: 'unrecognized' };
    case 'malformed':
      return { kind: 'malformed', reason: 'schema' };
  }
}

function getContentLength(response: IncomingMessage | undefined): number | undefined {
  const value = response?.headers?.['content-length'];
  if (typeof value !== 'string') {
    return undefined;
  }

  const contentLength = Number(value);
  return Number.isSafeInteger(contentLength) && contentLength >= 0 ? contentLength : undefined;
}

export function createTransportError(
  reason: 'request' | 'response',
  _error: unknown,
): BoundedMetadataTransportError {
  return { kind: 'transport-error', reason };
}