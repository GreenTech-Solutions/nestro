import { MAX_REGISTRY_REDIRECTS } from '../../config';
import { runBoundedMetadataRequest } from '../metadataRunner';
import type { BoundedMetadataOutcome, MetadataSchemaResult } from '../metadataRunner';

export interface RegistryRequestOptions {
  headers: Readonly<Record<string, string>>;
  ca: string | undefined;
  rejectUnauthorized: boolean | undefined;
}

/** Requests a registry document over HTTPS, following redirects and dropping credentials when one leaves the origin. */
export async function requestRegistryPayload<T>(
  url: string,
  parse: (payload: unknown) => MetadataSchemaResult<T>,
  packageName: string,
  options: RegistryRequestOptions,
  signal?: AbortSignal,
): Promise<BoundedMetadataOutcome<T>> {
  let requestUrl = url;
  let headers = options.headers;

  for (let redirectCount = 0; ; redirectCount += 1) {
    const outcome = await runBoundedMetadataRequest(requestUrl, {
      parse,
      signal,
      headers,
      ca: options.ca,
      rejectUnauthorized: options.rejectUnauthorized,
      timeoutErrorMessage: `npm registry request timed out after 15000ms for ${packageName}`,
      overflowErrorMessage: `npm registry response exceeded 5242880 bytes for ${packageName}`,
    });
    const location = getRedirectLocation(outcome);
    if (location === undefined) {
      return outcome;
    }
    if (redirectCount >= MAX_REGISTRY_REDIRECTS) {
      return { kind: 'transport-error', reason: 'request' };
    }

    const redirectedUrl = resolveRedirectUrl(requestUrl, location);
    if (redirectedUrl === undefined) {
      return { kind: 'transport-error', reason: 'request' };
    }
    if (!sameOrigin(requestUrl, redirectedUrl)) {
      headers = withoutAuthorization(headers);
    }
    requestUrl = redirectedUrl;
  }
}

function getRedirectLocation<T>(outcome: BoundedMetadataOutcome<T>): string | undefined {
  if (outcome.kind !== 'transport-error'
    || outcome.statusCode === undefined
    || outcome.statusCode < 300
    || outcome.statusCode >= 400) {
    return undefined;
  }
  return outcome.redirectLocation;
}

function resolveRedirectUrl(currentUrl: string, location: string): string | undefined {
  try {
    const redirected = new URL(location, currentUrl);
    if (redirected.protocol !== 'https:' || redirected.username !== '' || redirected.password !== '') {
      return undefined;
    }
    return redirected.toString();
  }
  catch {
    return undefined;
  }
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  }
  catch {
    return false;
  }
}

function withoutAuthorization(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const safeHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'authorization') {
      safeHeaders[name] = value;
    }
  }
  return safeHeaders;
}