export const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org/';

/** The registry URL as an HTTPS URL string without embedded credentials; throws for any other protocol. */
export function normalizeRegistryUrl(registryUrl: string): string {
  const registry = new URL(registryUrl);
  if (registry.protocol !== 'https:') {
    throw new Error('Registry URL must use HTTPS.');
  }
  registry.username = '';
  registry.password = '';
  return registry.toString();
}

/** The packument URL of an already URL-encoded package name beneath the registry. */
export function buildRegistryPackageUrl(registryUrl: string, encodedName: string): string {
  const registryString = normalizeRegistryUrl(registryUrl);
  const baseUrl = registryString.endsWith('/') ? registryString : `${registryString}/`;
  return new URL(encodedName, baseUrl).toString();
}