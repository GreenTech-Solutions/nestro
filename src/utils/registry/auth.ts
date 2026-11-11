import { parseAuthConfigKey } from './npmrc';
import type { AuthScope } from './npmrc';

export interface RegistryCredentials {
  /** npm-style config holding `//host/path/:_authToken` and similar scoped keys. */
  config: ReadonlyMap<string, string>;
  authToken: string | undefined;
  authIdent: string | undefined;
  /** Registry the token and ident apply to. */
  authRegistryUrl: string | undefined;
}

/** The `Authorization` header for a request: the longest matching scoped npm credential, else the Yarn or Bun one. */
export function getAuthorizationHeader(requestUrl: string, credentials: RegistryCredentials): string | undefined {
  const request = new URL(requestUrl);
  const { config, authToken, authIdent, authRegistryUrl } = credentials;
  const scopes = new Map<string, AuthScope>();
  for (const key of config.keys()) {
    const auth = parseAuthConfigKey(key);
    if (auth !== undefined && auth.origin === request.origin && request.pathname.startsWith(auth.pathname)) {
      scopes.set(auth.scopeKey, auth);
    }
  }

  const orderedScopes = [...scopes.values()].sort((left, right) => right.pathname.length - left.pathname.length);
  for (const scope of orderedScopes) {
    const token = config.get(`${scope.scopeKey}:_authToken`);
    if (token !== undefined && token !== '') {
      return `Bearer ${token}`;
    }

    const auth = config.get(`${scope.scopeKey}:_auth`);
    if (auth !== undefined && auth !== '') {
      return `Basic ${auth}`;
    }

    const username = config.get(`${scope.scopeKey}:username`);
    const password = config.get(`${scope.scopeKey}:_password`);
    if (username !== undefined && password !== undefined) {
      const decodedPassword = Buffer.from(password, 'base64').toString('utf8');
      return `Basic ${Buffer.from(`${username}:${decodedPassword}`).toString('base64')}`;
    }
  }
  if (authToken !== undefined && authToken !== ''
    && authRegistryUrl !== undefined && isWithinRegistryPath(request, authRegistryUrl)) {
    return `Bearer ${authToken}`;
  }
  if (authIdent !== undefined && authIdent !== ''
    && authRegistryUrl !== undefined && isWithinRegistryPath(request, authRegistryUrl)) {
    return `Basic ${encodeYarnAuthIdent(authIdent)}`;
  }
  return undefined;
}

function isWithinRegistryPath(request: URL, registryUrl: string): boolean {
  try {
    const registry = new URL(registryUrl);
    const registryPath = registry.pathname.endsWith('/') ? registry.pathname : `${registry.pathname}/`;
    return request.origin === registry.origin && request.pathname.startsWith(registryPath);
  }
  catch {
    return false;
  }
}

function encodeYarnAuthIdent(value: string): string {
  return value.includes(':') ? Buffer.from(value).toString('base64') : value;
}