export function isVersionOutdated(current: string, latest: string): boolean {
    const clean = current.replace(/^[^0-9]*/, '').trim();
    return clean !== latest;
}
