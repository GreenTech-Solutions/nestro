/** The scope of an `@scope/name` package, without the `@`; undefined for an unscoped or malformed name. */
export function getPackageScope(packageName: string): string | undefined {
  if (!packageName.startsWith('@')) {
    return undefined;
  }
  const scopeEndIndex = packageName.indexOf('/');
  return scopeEndIndex <= 1 ? undefined : packageName.slice(1, scopeEndIndex);
}

/** The configuration a scope map holds for the package's scope. */
export function getScopeConfiguration<T>(
  packageName: string,
  scopes: ReadonlyMap<string, T>,
): T | undefined {
  const scope = getPackageScope(packageName);
  return scope === undefined ? undefined : scopes.get(scope);
}