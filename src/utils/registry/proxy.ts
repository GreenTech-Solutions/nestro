/** The `NO_PROXY` entries from Yarn, npm config and the environment, joined by commas; undefined when none is set. */
export function getNoProxyConfiguration(
  config: ReadonlyMap<string, string>,
  yarnNoProxy: string | undefined,
): string | undefined {
  const values = [yarnNoProxy, config.get('no-proxy'), process.env.NO_PROXY, process.env.no_proxy]
    .filter((value): value is string => value !== undefined && value.trim() !== '');
  return values.length === 0 ? undefined : values.join(',');
}

/** True when the host matches a `*`, exact, or leading-dot suffix entry of the comma-separated list. */
export function isNoProxyHost(hostname: string, noProxy: string | undefined): boolean {
  if (noProxy === undefined) {
    return false;
  }

  const normalizedHostname = hostname.toLowerCase().replace(/\.$/, '');
  return noProxy.split(',').some((rawEntry) => {
    const entry = rawEntry.trim().toLowerCase().replace(/\.$/, '');
    if (entry === '*') {
      return true;
    }
    if (entry.startsWith('.')) {
      const suffix = entry.slice(1);
      return normalizedHostname === suffix || normalizedHostname.endsWith(entry);
    }
    return normalizedHostname === entry;
  });
}